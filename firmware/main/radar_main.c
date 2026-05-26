#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/ringbuf.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "driver/uart.h"
#include "cJSON.h"
#include "rom/ets_sys.h"
#include "ping/ping_sock.h"
#include "lwip/ip_addr.h"

static const char *TAG = "radar";

static EventGroupHandle_t s_wifi_events;
#define WIFI_CONNECTED_BIT BIT0

// =========================================================================
//  Gateway ping — periodic ICMP echo to keep the radio busy and stabilize
//  the CSI reporting rate.  Frames are also visible on-channel to the other
//  sensors in promiscuous mode, so a single ping session per sensor boosts
//  CSI throughput for the whole fleet.
// =========================================================================

#if CONFIG_RADAR_PING_ENABLED
static esp_ping_handle_t s_ping = NULL;
static volatile uint32_t s_ping_recv = 0;
static volatile uint32_t s_ping_lost = 0;
static int s_ping_interval_ms = CONFIG_RADAR_PING_INTERVAL_MS;
static esp_netif_t *s_sta_netif = NULL;

static void ping_on_success(esp_ping_handle_t hdl, void *args)
{
    (void) hdl; (void) args;
    s_ping_recv++;
}

static void ping_on_timeout(esp_ping_handle_t hdl, void *args)
{
    (void) hdl; (void) args;
    s_ping_lost++;
}

static void ping_stop(void)
{
    if (s_ping) {
        esp_ping_stop(s_ping);
        esp_ping_delete_session(s_ping);
        s_ping = NULL;
    }
}

static void ping_start(void)
{
    if (!s_sta_netif) return;
    ping_stop();

    esp_netif_ip_info_t ip = { 0 };
    if (esp_netif_get_ip_info(s_sta_netif, &ip) != ESP_OK || ip.gw.addr == 0) {
        ESP_LOGW(TAG, "ping_start: no gateway yet");
        return;
    }

    esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
    cfg.target_addr.type = IPADDR_TYPE_V4;
    cfg.target_addr.u_addr.ip4.addr = ip.gw.addr;
    cfg.count = 0;                       // forever
    cfg.interval_ms = s_ping_interval_ms;
    cfg.timeout_ms = 1000;
    cfg.task_stack_size = 4096;
    cfg.task_prio = 3;

    esp_ping_callbacks_t cbs = {
        .on_ping_success = ping_on_success,
        .on_ping_timeout = ping_on_timeout,
        .on_ping_end = NULL,
        .cb_args = NULL,
    };
    if (esp_ping_new_session(&cfg, &cbs, &s_ping) == ESP_OK && s_ping) {
        esp_ping_start(s_ping);
        ESP_LOGI(TAG, "ping started → gw=" IPSTR " every %d ms",
            IP2STR(&ip.gw), s_ping_interval_ms);
    } else {
        s_ping = NULL;
        ESP_LOGW(TAG, "ping session create failed");
    }
}
#endif  // CONFIG_RADAR_PING_ENABLED

// =========================================================================
//  NVS helpers — persistent SSID/password storage
// =========================================================================

#define NVS_NS "radar"
#define SSID_MAX 33
#define PW_MAX   65

static char s_ssid[SSID_MAX];
static char s_password[PW_MAX];

static void nvs_load_string(const char *key, char *out, size_t out_sz, const char *fallback)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK) {
        size_t sz = out_sz;
        esp_err_t r = nvs_get_str(h, key, out, &sz);
        nvs_close(h);
        if (r == ESP_OK) return;
    }
    strncpy(out, fallback, out_sz - 1);
    out[out_sz - 1] = '\0';
}

static esp_err_t nvs_store_string(const char *key, const char *val)
{
    nvs_handle_t h;
    esp_err_t r = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;
    r = nvs_set_str(h, key, val);
    if (r == ESP_OK) r = nvs_commit(h);
    nvs_close(h);
    return r;
}

// =========================================================================
//  Output pipeline — ring buffer drained by a dedicated UART writer task.
//  Why: Wi-Fi callbacks run at high priority and fire faster than printf can
//  flush to UART. Naive printf in the callback races with itself and emits
//  truncated lines. Ringbuffer + drainer task = lossless serialization.
// =========================================================================

#define LINE_MAX 1024
// 32 KB gives ~280 sniff events of headroom while the drainer flushes at 921600 baud.
#define RING_BYTES (32 * 1024)
static RingbufHandle_t s_ring;
static uint32_t s_drops = 0;

static void IRAM_ATTR emit_line(const char *fmt, ...)
{
    char buf[LINE_MAX];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n <= 0) return;
    if (n > (int) sizeof(buf)) n = sizeof(buf);
    if (xRingbufferSend(s_ring, buf, n, 0) != pdTRUE) {
        s_drops++;
    }
}

static void uart_writer_task(void *arg)
{
    while (1) {
        size_t sz = 0;
        char *item = (char *) xRingbufferReceive(s_ring, &sz, pdMS_TO_TICKS(100));
        if (item) {
            fwrite(item, 1, sz, stdout);
            vRingbufferReturnItem(s_ring, item);
        }
        fflush(stdout);
    }
}

// =========================================================================
//  802.11 frame parsing helpers (promiscuous mode)
// =========================================================================

typedef struct {
    uint8_t frame_ctrl[2];
    uint8_t duration[2];
    uint8_t addr1[6];   // dest / RA
    uint8_t addr2[6];   // src / TA
    uint8_t addr3[6];   // BSSID / SA
    uint8_t seq_ctrl[2];
} __attribute__((packed)) wifi_mac_hdr_t;

static const char *frame_type_str(uint8_t fc0)
{
    uint8_t type    = (fc0 >> 2) & 0x3;
    uint8_t subtype = (fc0 >> 4) & 0xF;
    if (type == 0) {  // management
        switch (subtype) {
            case 0x0: return "assoc-req";
            case 0x1: return "assoc-resp";
            case 0x4: return "probe-req";
            case 0x5: return "probe-resp";
            case 0x8: return "beacon";
            case 0xB: return "auth";
            case 0xC: return "deauth";
            default:  return "mgmt";
        }
    } else if (type == 1) {
        return "ctrl";
    } else if (type == 2) {
        return "data";
    }
    return "?";
}

// =========================================================================
//  Promiscuous (sniffing) callback
// =========================================================================

static void IRAM_ATTR sniffer_cb(void *buf, wifi_promiscuous_pkt_type_t type)
{
    if (type == WIFI_PKT_MISC) return;  // unsupported frames, skip

    const wifi_promiscuous_pkt_t *pkt = (wifi_promiscuous_pkt_t *) buf;
    const wifi_pkt_rx_ctrl_t *rx = &pkt->rx_ctrl;
    if (rx->sig_len < (int) sizeof(wifi_mac_hdr_t)) return;

    const wifi_mac_hdr_t *hdr = (const wifi_mac_hdr_t *) pkt->payload;
    const char *kind = frame_type_str(hdr->frame_ctrl[0]);

    emit_line("{\"t\":\"sniff\",\"sid\":\"%s\",\"k\":\"%s\",\"rssi\":%d,\"ch\":%u,\"src\":\"%02x%02x%02x%02x%02x%02x\",\"dst\":\"%02x%02x%02x%02x%02x%02x\",\"len\":%d}\n",
        CONFIG_RADAR_SENSOR_ID, kind, rx->rssi, rx->channel,
        hdr->addr2[0], hdr->addr2[1], hdr->addr2[2], hdr->addr2[3], hdr->addr2[4], hdr->addr2[5],
        hdr->addr1[0], hdr->addr1[1], hdr->addr1[2], hdr->addr1[3], hdr->addr1[4], hdr->addr1[5],
        rx->sig_len);
}

// =========================================================================
//  CSI callback
// =========================================================================

static void csi_cb(void *ctx, wifi_csi_info_t *info)
{
    if (!info || !info->buf || info->len <= 0) return;

    const wifi_pkt_rx_ctrl_t *rx = &info->rx_ctrl;
    const uint8_t *mac = info->mac;

    // CSI buffer is an interleaved (imag, real) sequence of int8 per subcarrier.
    // For HT20 we typically get ~128 bytes = 64 subcarriers. Serialize the
    // whole event into a single line before pushing to the ring buffer, so the
    // drainer can write it atomically.
    char buf[LINE_MAX];
    int n = snprintf(buf, sizeof(buf),
        "{\"t\":\"csi\",\"sid\":\"%s\",\"src\":\"%02x%02x%02x%02x%02x%02x\",\"rssi\":%d,\"ch\":%u,\"len\":%d,\"data\":[",
        CONFIG_RADAR_SENSOR_ID,
        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
        rx->rssi, rx->channel, info->len);
    for (int i = 0; i < info->len && n < (int) sizeof(buf) - 8; ++i) {
        n += snprintf(buf + n, sizeof(buf) - n, "%d%s",
            (int8_t) info->buf[i], (i == info->len - 1) ? "" : ",");
    }
    n += snprintf(buf + n, sizeof(buf) - n, "]}\n");
    if (xRingbufferSend(s_ring, buf, n, 0) != pdTRUE) {
        s_drops++;
    }
}

// =========================================================================
//  Wi-Fi event handler — connect / reconnect logic
// =========================================================================

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "STA disconnected — retrying");
        xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *evt = (ip_event_got_ip_t *) data;
        ESP_LOGI(TAG, "got IP " IPSTR, IP2STR(&evt->ip_info.ip));
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
#if CONFIG_RADAR_PING_ENABLED
        s_sta_netif = evt->esp_netif;
        ping_start();
#endif
    }
}

// =========================================================================
//  Sniffer + CSI configuration
// =========================================================================

static void enable_sniffing_and_csi(void)
{
    // ----- Promiscuous sniffing -----
    wifi_promiscuous_filter_t filter = {
        // Mgmt + data frames carry the most interesting signals (probe-req, beacons,
        // data frames from nearby devices). Skip ctrl to limit UART throughput.
        .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA,
    };
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filter));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_rx_cb(sniffer_cb));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));

    // ----- CSI -----
    wifi_csi_config_t csi_cfg = {
        .lltf_en           = true,
        .htltf_en          = true,
        .stbc_htltf2_en    = true,
        .ltf_merge_en      = true,
        .channel_filter_en = true,   // only frames on our STA channel
        .manu_scale        = false,
        .shift             = false,
    };
    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_cfg));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_cb, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));

    ESP_LOGI(TAG, "sniffing + CSI enabled");
}

// =========================================================================
//  Wi-Fi STA init (connects to bq-radar so CSI has traffic to chew on)
// =========================================================================

static void wifi_init_sta(void)
{
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &on_wifi_event, NULL, NULL));

    wifi_config_t wc = { 0 };
    // wifi_config_t.sta.ssid/password are byte arrays, not C strings. We zero
    // the struct above so any unused tail is already 0-padded; we only copy
    // the meaningful bytes from our null-terminated buffers.
    size_t ssid_len = strnlen(s_ssid, sizeof(wc.sta.ssid));
    memcpy(wc.sta.ssid, s_ssid, ssid_len);
    size_t pw_len = strnlen(s_password, sizeof(wc.sta.password));
    memcpy(wc.sta.password, s_password, pw_len);
    wc.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wc.sta.pmf_cfg.capable = true;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    // Country code = FR → unlocks channel 13 on which the Pi AP runs.
    wifi_country_t country = {
        .cc       = "FR",
        .schan    = 1,
        .nchan    = 13,
        .policy   = WIFI_COUNTRY_POLICY_MANUAL,
    };
    ESP_ERROR_CHECK(esp_wifi_set_country(&country));

    ESP_ERROR_CHECK(esp_wifi_start());
}

// =========================================================================
//  app_main
// =========================================================================

// =========================================================================
//  Command listener — JSON commands over UART RX
// =========================================================================

#define CMD_LINE_MAX 512
#define UART_RX_BUF 2048

static void cmd_emit_ack(const char *cmd_name, bool ok, const char *detail)
{
    if (detail) {
        emit_line("{\"t\":\"ack\",\"sid\":\"%s\",\"cmd\":\"%s\",\"ok\":%s,\"detail\":\"%s\"}\n",
            CONFIG_RADAR_SENSOR_ID, cmd_name, ok ? "true" : "false", detail);
    } else {
        emit_line("{\"t\":\"ack\",\"sid\":\"%s\",\"cmd\":\"%s\",\"ok\":%s}\n",
            CONFIG_RADAR_SENSOR_ID, cmd_name, ok ? "true" : "false");
    }
}

static void handle_set_wifi(cJSON *root)
{
    cJSON *ssid = cJSON_GetObjectItem(root, "ssid");
    cJSON *pw   = cJSON_GetObjectItem(root, "password");
    if (!cJSON_IsString(ssid) || !cJSON_IsString(pw)) {
        cmd_emit_ack("set_wifi", false, "missing ssid/password");
        return;
    }
    if (strlen(ssid->valuestring) >= SSID_MAX || strlen(pw->valuestring) >= PW_MAX) {
        cmd_emit_ack("set_wifi", false, "ssid or password too long");
        return;
    }
    esp_err_t r1 = nvs_store_string("ssid", ssid->valuestring);
    esp_err_t r2 = nvs_store_string("pw", pw->valuestring);
    bool ok = (r1 == ESP_OK && r2 == ESP_OK);
    cmd_emit_ack("set_wifi", ok, ok ? "saved, rebooting" : "nvs write failed");
    if (ok) {
        vTaskDelay(pdMS_TO_TICKS(800));
        esp_restart();
    }
}

static void handle_command_line(const char *line)
{
    cJSON *root = cJSON_Parse(line);
    if (!root) return;
    cJSON *cmd = cJSON_GetObjectItem(root, "cmd");
    if (cJSON_IsString(cmd)) {
        if (strcmp(cmd->valuestring, "set_wifi") == 0) {
            handle_set_wifi(root);
        } else if (strcmp(cmd->valuestring, "reboot") == 0) {
            cmd_emit_ack("reboot", true, NULL);
            vTaskDelay(pdMS_TO_TICKS(500));
            esp_restart();
        } else if (strcmp(cmd->valuestring, "ping") == 0) {
            cmd_emit_ack("ping", true, NULL);
        } else if (strcmp(cmd->valuestring, "set_ping_rate") == 0) {
#if CONFIG_RADAR_PING_ENABLED
            cJSON *ms = cJSON_GetObjectItem(root, "interval_ms");
            if (!cJSON_IsNumber(ms)) {
                cmd_emit_ack("set_ping_rate", false, "missing interval_ms");
            } else {
                int v = (int) ms->valueint;
                if (v < 10 || v > 5000) {
                    cmd_emit_ack("set_ping_rate", false, "out of range 10..5000");
                } else {
                    s_ping_interval_ms = v;
                    ping_start();
                    cmd_emit_ack("set_ping_rate", true, NULL);
                }
            }
#else
            cmd_emit_ack("set_ping_rate", false, "ping not built in");
#endif
        } else if (strcmp(cmd->valuestring, "get_config") == 0) {
            emit_line("{\"t\":\"ack\",\"sid\":\"%s\",\"cmd\":\"get_config\",\"ok\":true,\"ssid\":\"%s\"}\n",
                CONFIG_RADAR_SENSOR_ID, s_ssid);
        } else {
            cmd_emit_ack(cmd->valuestring, false, "unknown command");
        }
    }
    cJSON_Delete(root);
}

static void cmd_listener_task(void *arg)
{
    char line[CMD_LINE_MAX];
    size_t pos = 0;
    uint8_t byte;
    while (1) {
        int n = uart_read_bytes(UART_NUM_0, &byte, 1, pdMS_TO_TICKS(200));
        if (n != 1) continue;
        if (byte == '\n' || byte == '\r') {
            if (pos > 0) {
                line[pos] = '\0';
                if (line[0] == '{') {
                    handle_command_line(line);
                }
                pos = 0;
            }
        } else if (pos < CMD_LINE_MAX - 1) {
            line[pos++] = (char) byte;
        } else {
            pos = 0;  // line too long, discard
        }
    }
}

void app_main(void)
{
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    // Set up the ring buffer + drainer BEFORE wifi callbacks may fire.
    s_ring = xRingbufferCreate(RING_BYTES, RINGBUF_TYPE_NOSPLIT);
    configASSERT(s_ring != NULL);
    xTaskCreate(uart_writer_task, "uart_writer", 4096, NULL, 5, NULL);

    // Install UART driver for RX so we can receive runtime commands from the Pi.
    // TX stays on the existing console (ringbuffer drainer writes via printf/fwrite).
    uart_driver_install(UART_NUM_0, UART_RX_BUF, 0, 0, NULL, 0);
    xTaskCreate(cmd_listener_task, "cmd_listener", 4096, NULL, 4, NULL);

    // Load SSID/password from NVS, fall back to Kconfig defaults.
    nvs_load_string("ssid", s_ssid, sizeof(s_ssid), CONFIG_RADAR_WIFI_SSID);
    nvs_load_string("pw",   s_password, sizeof(s_password), CONFIG_RADAR_WIFI_PASSWORD);

    uint8_t self_mac[6];
    esp_read_mac(self_mac, ESP_MAC_WIFI_STA);
    ESP_LOGI(TAG, "wifi-radar boot — mac=%02x:%02x:%02x:%02x:%02x:%02x ssid='%s'",
        self_mac[0], self_mac[1], self_mac[2], self_mac[3], self_mac[4], self_mac[5],
        s_ssid);

    wifi_init_sta();

    // Wait until we have an IP, otherwise CSI fires before the STA is on a stable channel.
    EventBits_t bits = xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT,
        pdFALSE, pdTRUE, pdMS_TO_TICKS(20000));
    if (!(bits & WIFI_CONNECTED_BIT)) {
        ESP_LOGW(TAG, "no connection after 20s — enabling sniffing+CSI anyway");
    }

    enable_sniffing_and_csi();

    // Status heartbeat — confirms the main task is still alive. Emitted via
    // the same ring buffer so it never collides with sniff/csi output.
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(10000));
        wifi_ap_record_t ap = { 0 };
        UBaseType_t free_bytes = 0;
        vRingbufferGetInfo(s_ring, NULL, NULL, NULL, NULL, &free_bytes);
#if CONFIG_RADAR_PING_ENABLED
        unsigned long ping_recv = s_ping_recv;
        unsigned long ping_lost = s_ping_lost;
        int ping_ms = s_ping_interval_ms;
#else
        unsigned long ping_recv = 0;
        unsigned long ping_lost = 0;
        int ping_ms = 0;
#endif
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            emit_line("{\"t\":\"hb\",\"sid\":\"%s\",\"connected\":true,\"ssid\":\"%s\",\"rssi\":%d,\"ch\":%d,\"drops\":%lu,\"ring_free\":%u,\"ping\":{\"recv\":%lu,\"lost\":%lu,\"ms\":%d}}\n",
                CONFIG_RADAR_SENSOR_ID, ap.ssid, ap.rssi, ap.primary, (unsigned long) s_drops, (unsigned) free_bytes,
                ping_recv, ping_lost, ping_ms);
        } else {
            emit_line("{\"t\":\"hb\",\"sid\":\"%s\",\"connected\":false,\"drops\":%lu,\"ring_free\":%u,\"ping\":{\"recv\":%lu,\"lost\":%lu,\"ms\":%d}}\n",
                CONFIG_RADAR_SENSOR_ID, (unsigned long) s_drops, (unsigned) free_bytes,
                ping_recv, ping_lost, ping_ms);
        }
    }
}
