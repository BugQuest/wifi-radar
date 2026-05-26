idf_component_register(
    SRCS "radar_main.c"
    INCLUDE_DIRS "."
    # lwip carries the esp_ping socket helper (ping/ping_sock.h).
    REQUIRES esp_wifi esp_netif esp_event nvs_flash driver json lwip
)
