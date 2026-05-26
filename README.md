# WiFi Radar

Détection de présence, inventaire d'appareils WiFi, **trilatération 2D** et **détection de mouvement par variance CSI**, à partir de **N ESP32-DevKitC** pilotés par un **Raspberry Pi 4**. Une **web app temps réel** (FastAPI + React Three Fiber) visualise les capteurs sur le sol, les devices détectés positionnés en mètres réels, et la présence/mouvement dans la pièce.

Trois fonctions complémentaires :

1. **Sniffing passif 802.11** — probe requests, beacons, data frames → inventaire des MACs alentour avec vendor lookup (OUI), RSSI par capteur, taux d'activité.
2. **Trilatération 2D** — avec ≥3 ESP32 calibrés, position (x, z) en mètres sur le sol via moindres carrés sur le modèle path-loss appliqué aux RSSI multi-capteurs.
3. **Détection présence + mouvement CSI** — variance temporelle sur les 64 sous-porteuses par capteur → carte de chaleur du sol cumulée + trail des positions + corrélation cross-capteurs pour filtrer le bruit.

---

## Sommaire

- [Aperçu](#aperçu)
- [Théorie](#théorie)
- [Architecture](#architecture)
- [Matériel requis](#matériel-requis)
- [Placement physique idéal des ESP32 et de l'AP](#placement-physique-idéal-des-esp32-et-de-lap)
- [Installation pas à pas](#installation-pas-à-pas)
- [Flashage multi-capteurs](#flashage-multi-capteurs)
- [Interface web — tour des panneaux](#interface-web--tour-des-panneaux)
- [Configuration WiFi runtime](#configuration-wifi-runtime)
- [Endpoints REST + WebSocket](#endpoints-rest--websocket)
- [Formats de données](#formats-de-données)
- [Persistence](#persistence)
- [Dépannage](#dépannage)
- [Honnêteté du code — ce qui est réel vs décoratif](#honnêteté-du-code--ce-qui-est-réel-vs-décoratif)
- [Structure du projet](#structure-du-projet)
- [Roadmap](#roadmap)

---

## Aperçu

```
ESP32 r0  ESP32 r1  ESP32 r2  (N capteurs identiques)
   │ USB     │ USB     │ USB
   └────┬────┴────┬────┘
        ▼         ▼
   Raspberry Pi 4 ── (WiFi dongle si Pi sert d'AP) ── radio AP
        │
   ┌────┴───────┐
   │  Backend   │   FastAPI + auto-baud serial + DuckDB + WebSocket
   │  port 8000 │
   └────┬───────┘
        │ HTTP / WS
        ▼
   Frontend (Vite + React + R3F + Tailwind)
```

Côté capteur, chaque ESP32 :

- Écoute en **mode promiscuous** toutes les trames Wi-Fi sur son canal.
- Active le **callback CSI** : pour chaque trame reçue, 64 sous-porteuses × (imag, real) int8 = 128 octets de réponse fréquentielle.
- Se **connecte en STA** à un AP (configurable runtime via NVS) pour locker un canal et permettre la trilatération sur des frames adressées.
- **Listener UART** qui reçoit des commandes JSON (set_wifi, ping, reboot, get_config).
- Sortie sérialisée ligne par ligne, drainée par un **ring buffer FreeRTOS** dans une tâche d'écriture dédiée (évite la race printf sous haut débit).

Côté Pi :

- **Auto-détection des ports** `/dev/ttyUSB*` (un reader async par port, auto-baud 115200 ↔ 921600).
- **Whitelist stricte** des événements (`t ∈ {sniff, csi, hb, ack}`, `sid` non vide).
- **State live** — devices avec rssi_by_sensor, vendor lookup offline (38k+ OUIs), trilatération moindres carrés.
- **Presence detector** — variance CSI rolling 30 samples, centroïde pondéré, corrélation Pearson, trail 30 s, heatmap 40×40 cellules sur 20×20 m.
- **System monitor** — CPU% global + per-core, température, RAM, load avg, throttling Pi (`vcgencmd get_throttled`).
- **WiFi config persistée** — JSON dans `~/wifi-radar-data/wifi-configs.json`, push runtime aux ESPs par UART.
- **Calibration sensors** — positions (x, z) en mètres persistées, override de l'auto-layout.
- **Persistence DuckDB** — tous les events sniff/csi flushés par batch 5 s, rotation parquet ZSTD horaire.

Côté navigateur :

- **Scène 3D** avec grille au sol 1 m, axes XZ gradués, anneaux 1/3/6/9/12 m.
- **Capteurs draggables** en mode calibration (📐) pour ajuster leur position physique réelle.
- **Devices** rendus avec **opacité = confiance de position** : 100% trilaterés, 45% bilaterés, 22% single-sensor (angle hashé), 15% sans capteur.
- **PresenceBlob + MotionTrail + HeatmapFloor** : 3 calques visuels de la présence détectée par CSI.
- **Panneaux flottants** draggables avec toolbar de toggle : Sensors diagnostic 📡, Presence 👤, Devices list 📋, CSI waterfall 🌊, Pi system 💻, WiFi config ⚙️, Path-loss calibration 📏.
- **Device detail** au clic : RSSI par capteur, distance estimée, position 2D, vitesse, packet feed live, trilateration debug step-by-step (🔍).
- **Mode Solo** 🔇 sur un device pour dim les autres + filtrer le CSI waterfall.
- **Focus camera** 🎯 — vol vers le device sélectionné en 700 ms.

---

## Théorie

### Sniffing promiscuous

`esp_wifi_set_promiscuous(true)` + callback rx_cb → toutes les trames du canal. On extrait MAC source/dest, type frame (beacon, probe-req, data, ...), RSSI au PHY, longueur, canal. Suffit pour inventorier les MACs autour. Note : depuis iOS 14 / Android 8, les probes sont MAC-randomisées (bit local set), donc on compte mieux qu'on identifie.

### Channel State Information (CSI)

`esp_wifi_set_csi(true)` + callback csi_cb → pour chaque frame, vecteur complexe `H[k]` (k=0..63) qui décrit l'atténuation et le déphasage par sous-porteuse OFDM. Codé en int8 interleaved (imag, real) → 128 octets par event CSI.

### Détection de mouvement par variance CSI

Un environnement statique → motif CSI stable. Un corps qui bouge → variations corrélées sur plusieurs sous-porteuses (le canal radio est modifié par la diffraction/réflexion sur le corps).

Algorithme :

1. Buffer rolling 30 derniers samples CSI par capteur.
2. Variance temporelle moyenne par sous-porteuse → score d'activité scalaire par capteur.
3. **Centroïde de présence** = `Σ (activity_i − floor) × pos_capteur_i / Σ (activity_i − floor)` (capteurs au-dessus du seuil de bruit).
4. **Corrélation Pearson cross-capteurs** sur les historiques d'activité → ρ proche de 1 = vrai mouvement environnemental, ρ proche de 0 = bruit local.
5. **Trail** : on garde (timestamp, x, z, intensity) sur 30 s, le frontend trace une line strip qui fade.
6. **Heatmap** : grille 40×40 cellules sur ±10 m, gaussian splat à la position centroïde, décay 1.2 %/s (demi-vie ~1 min). Auto-scale max → légende couleur reste lisible.

### Trilatération 2D

Avec **≥3 capteurs** voyant le même device avec RSSI frais (≤ 8 s) :

- Modèle path-loss : `RSSI(d) = RSSI_0 − 10·n·log10(d_m)` — par défaut `RSSI_0 = -30 dBm @ 1m`, `n = 2.5`. **Ces deux paramètres sont calibratables in situ via le panneau 📏** (régression linéaire sur mesures à distances connues, persisté dans `wifi-configs.json`).
- Distance estimée par capteur : `d_i = 10^((-30 − RSSI_i)/(10·n))`.
- Cercles `(x − x_i)² + (z − z_i)² = d_i²` → on linéarise en soustrayant l'équation du capteur de référence → système `A·[x z]ᵀ = b` à N-1 équations.
- Résolution moindres carrés : `(AᵀA)·v = Aᵀb` (matrice 2×2 inversée à la main).
- **Residual RMS** pour mesurer le fit + **confiance** = `exp(−residual/8) × clamp((max_rssi+95)/70)`.

Tu peux voir chaque étape du calcul en cliquant **🔍** dans le panel détail d'un device.

### Bilatération 1D

Avec **exactement 2 capteurs**, on ne peut pas résoudre une position 2D — on calcule un point sur la ligne entre les deux capteurs, biaisé par le delta RSSI via `tanh(Δrssi/15)`. Pas un vrai positionnement, juste un proxy 1D.

### Single-sensor fallback

Avec **1 capteur**, on connaît la distance (via path-loss) mais pas la direction. Le device est placé sur un cercle d'incertitude autour du capteur, à un angle déterministe hashé depuis sa MAC, avec **opacité réduite (22 %)** pour signaler visuellement qu'on devine.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  ESP32 r0    ESP32 r1    ESP32 r2     N capteurs, firmware identique │
│  ─────────────────────────────────                                   │
│  • Promiscuous sniffing (mgmt + data)                                │
│  • CSI rx callback (HT20 64 subcarriers)                             │
│  • STA → AP configurable runtime (NVS storage)                       │
│  • cmd_listener_task ← UART RX (set_wifi, ping, reboot, get_config)  │
│  • Ring buffer 32 KB + uart_writer_task → UART TX                    │
│  • Heartbeat 10 s : ssid, channel, rssi_to_ap, drops, ring_free      │
└────┬───────────┬───────────┬─────────────────────────────────────────┘
     │ USB       │ USB       │ USB           (auto-baud 115200/921600)
     ▼           ▼           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Pi 4 — Backend FastAPI (uvloop)                                     │
│                                                                      │
│  auto-discover /dev/ttyUSB* → N serial_reader tasks                  │
│  serial_writer.register_transport(device, t)  ← per-port outbound    │
│        │                                                             │
│        ▼ JSON whitelist (t ∈ {sniff,csi,hb,ack}, sid non vide)       │
│  event_bus (asyncio pubsub)                                          │
│        ├──► state.py        devices, sensors auto-layout / calib    │
│        │                    bilateration, trilateration LSQ          │
│        ├──► presence.py     CSI variance window, centroid,          │
│        │                    Pearson cross-correlation, heatmap       │
│        ├──► persistence.py  DuckDB batch flush, parquet hourly       │
│        ├──► system_stats.py CPU, temp, RAM, throttling               │
│        └──► ws.py           snapshot + live broadcast 1 Hz           │
│                                                                      │
│  REST: /api/{stats, devices, sensors, presence, system, ports,       │
│              configs, configs/<n>/{activate,apply}, aps,             │
│              sensors/<sid>/position, csi/recent, history/devices}    │
│  WS:   /ws                                                           │
│  Static: dist/ frontend                                              │
└────┬─────────────────────────────────────────────────────────────────┘
     │ HTTP / WebSocket
     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend — Vite + React + TS + R3F + Tailwind                       │
│                                                                      │
│  Scene3D                              StatsBar (top)                 │
│   ├─ Floor (grid 1m + axes XZ)         ├─ WS state, devices, rates   │
│   ├─ RangeRings 1/3/6/9/12 m           ├─ pills per sensor + drops   │
│   ├─ SensorDraggable × N               └─ ViewToolbar 📡👤📋🌊💻⚙📐  │
│   ├─ DeviceOrbit × M (opacity = pos                                  │
│   │  certainty: trilat / bilat /       Panneaux flottants draggables │
│   │  single / unknown)                  📡 SensorDiagnostics         │
│   ├─ CSIField (particles)               👤 PresencePanel             │
│   ├─ MotionTrail (history fade)         📋 DeviceList                │
│   ├─ PresenceBlob (centroid glow)       🌊 CSIWaterfall              │
│   ├─ HeatmapFloor (accumulated)         💻 SystemPanel (Pi resources)│
│   └─ CameraFocus (700 ms easeOut)       ⚙ ConfigPanel (WiFi configs) │
│                                         🔍 TrilaterationDebug modal  │
│  DeviceDetail (left overlay au clic):                                │
│   ├─ Toolbar: 🎯 Focus, 🔇 Solo, 📋 Copy MAC, 🌐 OUI, 🔍 Explain      │
│   ├─ RSSI per sensor + distance estimée                              │
│   ├─ Trilateration coords + residual + confidence                    │
│   ├─ Velocity vector (m/s + bearing)                                 │
│   ├─ Sparkline RSSI 60 derniers                                      │
│   └─ Live packet feed                                                │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Matériel requis

| Item | Critique ? | Notes |
|---|---|---|
| Raspberry Pi 4 (4 GB+) | ✅ | Ubuntu 24.04+ ou Pi OS 64-bit |
| microSD ≥ 32 GB A2 (ou SSD USB) | ✅ | ESP-IDF ~1.5 GB + cache |
| Alim Pi 5V/3A USB-C officielle | ✅ | Tension stable |
| 1 à N **ESP32-DevKitC V4** | ✅ | Module WROOM-32 ou -32U. **PAS** ESP32-S2 (pas de CSI) |
| Antenne externe IPEX/U.FL | ✅✅ | Si module -32U avec connecteur, drastiquement meilleur |
| Câble USB **data** (pas charge-only) | ✅ | Tester avec `dmesg \| tail` |
| Dongle WiFi USB 2.4 GHz (mode AP) | ⚠️ | Si tu veux que le Pi héberge l'AP. **Realtek RTL8188 = peu fiable** |
| Hub USB **alimenté externe** | ⚠️ | Recommandé si **3+ ESP32** ; la rail USB Pi sature ~600 mA |
| Connexion Ethernet OU 2e WiFi | ✅ | Pour ne pas perdre SSH quand wlan0 est utilisé |

### Pourquoi le hub USB alimenté ?

Pi 4 a 4 ports USB partageant ~600 mA. Trois ESP32 + un dongle Realtek peuvent dépasser ce budget pendant les bursts de flash ou les pointes de trafic. Symptôme : **les CP210x partent tous en `Input/output error` simultanément** et ne sont plus accessibles. Solution : hub avec alim externe, ou brancher les ESPs directement sur les ports Pi sans hub passif.

---

## Placement physique idéal des ESP32 et de l'AP

C'est la section la plus importante pour avoir des résultats exploitables.

### Principes

Tu veux trois propriétés :

1. **Triangulation possible** → 3 capteurs **non-colinéaires** (pas alignés sur une droite). Un triangle équilatéral est optimal.
2. **Multi-capteur visibility** → chaque MAC à surveiller doit être visible depuis ≥ 3 capteurs simultanément. Donc les capteurs entourent la zone d'intérêt, pas concentrés en un coin.
3. **CSI exploitable** → le canal radio entre l'AP et chaque ESP traverse la zone de présence. Le mouvement de corps perturbe les multipath de ce canal, c'est ça qu'on mesure.

### Géométrie recommandée

```
                    ╱╲                  Triangle équilatéral de 3-5 m de côté
                   ╱  ╲                 dans la pièce à surveiller.
                  ╱    ╲
                 ╱      ╲               Capteurs (• r0/r1/r2) à hauteur 1.5 m
              r2•────────•r1            sur trépieds ou étagères.
                 ╲      ╱
                  ╲    ╱                Zone d'intérêt = au centre du triangle.
                   ╲  ╱
                    •
                   r0
```

| Paramètre | Idéal | Min — Max |
|---|---|---|
| Côté du triangle | **3–5 m** | 1 m — 10 m |
| Hauteur des capteurs (du sol) | **1.2–1.5 m** | 0.8 — 2 m (uniforme entre eux) |
| Distance aux murs | **≥ 0.5 m** | éviter le contact direct (multipath fortement perturbé) |
| Distance à un objet métallique | **≥ 1 m** | armoires, frigo, écran TV |
| Orientation des antennes | **toutes verticales** | uniforme = polarisation cohérente |

### Pourquoi 3-5 m de côté ?

- **< 1 m** : les distances RSSI sont presque identiques entre les 3 capteurs (`Δrssi` < 5 dB) → trilatération instable, le bruit domine le signal.
- **3-5 m** : sweet spot. Suffisamment grand pour avoir des `Δrssi` significatifs (10-20 dB entre le capteur le plus proche et le plus loin), suffisamment petit pour que tous voient correctement même les petits émetteurs.
- **> 10 m** : un device au bord du triangle n'est plus vu par tous les capteurs (RSSI < -90 dBm = sous le seuil de détection). Bascule en bilatération ou single-sensor.

### Placement de l'AP

L'AP (Pi en hotspot via dongle, ou ton routeur domestique) :

- **Position** : à l'extérieur ou en bordure du triangle, **pas au centre**. Si l'AP est au centre, les 3 capteurs auront des RSSI vers l'AP très similaires, et la `channel_filter_en` du CSI filtre les frames de l'AP qui dominent → moins de diversité CSI.
- **Distance aux capteurs** : 3-10 m. Trop proche → saturation RSSI vers -20 dBm sur certains. Trop loin → l'association STA devient instable.
- **Canal** : choisir un canal **peu utilisé localement** :
  - En France : canal 13 (utilisé par peu de routeurs car bloqué USA)
  - En général : canaux **1, 6, ou 11** (les seuls non-recouvrants en 2.4 GHz US/EU)
  - Évite les canaux saturés (regarder dans le scan AP de l'UI)
- **Stabilité** : préférer un **vrai routeur secondaire** au dongle Realtek RTL8188 qui décroche régulièrement. Si tu utilises le dongle, accepte qu'il puisse falloir relancer `sudo nmcli connection up bq-radar` de temps en temps.

### Ce qu'il faut éviter

- ❌ Capteurs **alignés** (colinéaires) → la matrice de trilatération devient singulière, `det ≈ 0`, pas de solution.
- ❌ Capteurs **trop proches** (< 50 cm) → ils s'interfèrent entre eux pendant la phase d'association STA et le CSI.
- ❌ Capteurs **à des hauteurs différentes** → la trilatération est 2D (plan du sol), des Z différents introduisent une erreur systématique.
- ❌ AP en **5 GHz** → les ESP32 sont 2.4 GHz uniquement.

### Workflow de placement + calibration

1. **Pose physique** des 3 ESP32 selon les principes ci-dessus.
2. Branche-les sur le Pi (USB), boote le système.
3. Ouvre l'UI dans le navigateur.
4. Active le mode **📐 calibration** dans la toolbar topbar.
5. **Glisse chaque capteur** sur le sol gradué de l'UI à sa position physique réelle (lecture en mètres sur la grille).
6. Désactive 📐 pour locker.
7. La trilatération utilise désormais tes vraies coordonnées.

### Calibration path-loss in situ (panneau 📏)

Le modèle par défaut (`RSSI_0 = -30 dBm @ 1 m, n = 2.5`) marche en indoor générique mais peut être 50 % off chez toi. Le panneau **📏 Path-loss calibration** automatise le fit :

1. Place un device émetteur stable (téléphone en mode hotspot, montre connectée allumée…) à **distance connue** d'**un** capteur.
2. Ouvre **📏** dans la toolbar topbar.
3. Sélectionne le **sensor**, la **MAC cible** (dropdown trié par RSSI courant), saisis la **distance en m**, choisis la **durée** d'échantillonnage (5 s par défaut).
4. Clique **📡 Sample 5s** : l'UI agrège tous les sniffs `(src=mac, sid=sensor)` depuis le WebSocket pendant la fenêtre → calcule moyenne et écart-type.
5. Le point est ajouté au tableau. Déplace le device à une autre distance, recommence (idéalement **3 à 5 points** à des distances variées, par ex. 1 m / 2 m / 4 m / 7 m).
6. Dès 2 points, la section **Fit** apparaît : régression linéaire client-side sur `(log10(d), RSSI)` → `RSSI_0`, `n`, **R²** coloré (vert > 0.9 = excellent, jaune > 0.7 = correct, rouge = ajouter d'autres points).
7. **🚀 Apply to backend** → POST `/api/path-loss` → persisté + utilisé immédiatement par la trilatération (`state._rssi_to_distance` lit dynamiquement).

Plus besoin de toucher au code source : les paramètres sont stockés dans `~/wifi-radar-data/wifi-configs.json` sous la clé `path_loss`.

---

## Installation pas à pas

### 1. Préparer le Raspberry Pi

```bash
sudo apt-get update
sudo apt-get install -y \
  git wget flex bison gperf \
  python3 python3-pip python3-venv \
  cmake ninja-build ccache \
  libffi-dev libssl-dev \
  dfu-util libusb-1.0-0

sudo usermod -aG dialout $USER
# Reconnecte-toi pour que dialout prenne effet
```

### 2. ESP-IDF v5.5

```bash
mkdir -p ~/esp && cd ~/esp
git clone --depth 1 -b release/v5.5 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf && ./install.sh esp32
```

### 3. Cloner le projet

```bash
cd ~ && git clone <ce-repo>.git wifi-radar && cd wifi-radar
```

### 4. (Optionnel) Pi en AP via dongle USB

Si tu utilises le Pi comme AP pour les ESPs (par opposition à un routeur séparé) :

```bash
DONGLE=$(iw dev | awk '/Interface/ {print $2}' | grep -v wlan0 | head -1)
WPAPSK=$(openssl rand -base64 16 | tr -d '/+=' | cut -c1-20)
echo "AP password: $WPAPSK"
sudo nmcli device wifi hotspot ifname $DONGLE con-name bq-radar ssid bq-radar password "$WPAPSK"
```

### 5. Backend Python

```bash
cd ~/wifi-radar/backend
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e .
```

Lancer (auto-baud par port, va détecter 115200 ou 921600 selon ton firmware) :

```bash
nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 \
  > /tmp/uvicorn.log 2>&1 < /dev/null & disown
```

Variables d'env :

| Var | Défaut | Sens |
|---|---|---|
| `RADAR_SERIAL` | auto-glob `/dev/ttyUSB*` | comma list ou glob pattern |
| `RADAR_BAUD` | `921600` | baud initial (auto-rotation si garbage) |
| `RADAR_DATA` | `~/wifi-radar-data` | DuckDB + parquet + configs JSON |
| `RADAR_STATIC` | `<repo>/backend/static` | frontend statique |

### 6. Frontend (build sur ta machine de dev avec Node 20+)

```bash
cd frontend
npm install
npm run build
# → dist/ contient index.html + assets/
```

Deploy sur le Pi :

```bash
ssh PI 'rm -rf ~/wifi-radar/backend/static/* && mkdir -p ~/wifi-radar/backend/static'
scp -r dist/* PI:~/wifi-radar/backend/static/
```

Dev avec hot reload pointant vers le Pi :

```bash
cd frontend && npm run dev    # http://localhost:5173, proxy /api et /ws vers le Pi
```

### 7. Service systemd (optionnel)

`/etc/systemd/system/wifi-radar.service` :

```ini
[Unit]
Description=WiFi Radar backend
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/wifi-radar/backend
ExecStart=/home/YOUR_USER/wifi-radar/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now wifi-radar
sudo journalctl -u wifi-radar -f
```

---

## Flashage multi-capteurs

Le firmware unique embarque un `CONFIG_RADAR_SENSOR_ID` (défaut `r0`) — le helper `flash_sid.sh` patche cette valeur, rebuild, flashe, restore. Il **stoppe le backend** au début, mais **ne le redémarre pas** (à toi de le faire après le dernier flash, pour pouvoir enchaîner les 3 sans interférence).

```bash
cd ~/wifi-radar/firmware

# Pour chaque ESP32 (un seul branché à la fois sur /dev/ttyUSB0) :
./flash_sid.sh r0
# débranche, branche le 2e
./flash_sid.sh r1
# débranche, branche le 3e
./flash_sid.sh r2

# Quand tout est flashé, rebranche les 3 et relance le backend
cd ~/wifi-radar/backend
nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 \
    > /tmp/uvicorn.log 2>&1 < /dev/null & disown
```

Une fois reflashés en NVS-aware, tous les changements WiFi se font **runtime** via l'UI ⚙️, plus besoin de reflasher.

---

## Interface web — tour des panneaux

`http://<pi>:8000/`

### StatsBar (top)

WS state, channel, AP RSSI, devices count, sniff/s, csi/s, totaux cumulés, pills par capteur avec rate + drops. À droite : **ViewToolbar** pour toggle chaque panneau (📡 👤 📋 🌊 💻 ⚙ 📏) + bouton **📐** mode calibration capteurs (drag-and-drop).

### Scène 3D (centre)

- **Floor** : grille 1 m, axes XZ gradués, label origine, anneaux de portée 1/3/6/9/12 m.
- **Sensor nodes** : 1 sphère/icosaèdre cyan par capteur, label flottant `r0 · bq-radar (-52 dBm)` ou `r0 · sniffing (no AP)`. Halo qui pulse avec le sniff/s.
- **DeviceOrbit** × N : sphères colorées (couleur hashée depuis MAC), opacité = confiance position :
  - **Solide (60-100 %)** = trilatération (≥3 capteurs frais)
  - **Semi-transparent (45 %)** = bilatération (2 capteurs)
  - **Très fade (22 %)** = single sensor, angle hashé (orbit ring)
  - **Quasi-invisible (15 %)** = pas de capteur frais
- **CSIField** : 1500 particules dans une sphère qui s'agitent avec la variance CSI courante.
- **MotionTrail** : line strip cyan des 30 dernières positions de présence, fade par âge.
- **PresenceBlob** : disque lumineux au sol à la position centroïde présence, cyan→orange selon intensité, taille pulsante.
- **HeatmapFloor** : grille 40×40 sur ±10 m, accumule l'intensité de présence avec décay 1 min, colormap transparent → cyan → jaune → orange-rouge.
- **OrbitControls** : drag pour pivoter, wheel pour zoom, right-drag pour pan.

### DeviceDetail (overlay gauche, au clic sur un device)

- Header avec vendor + MAC + ✕ close
- **Toolbar** : 🎯 Focus camera (animation 700 ms), 🔇 Solo (dim + filtre waterfall), 📋 Copy MAC, 🌐 IEEE OUI, 🔍 Trilateration debug modal
- Stats : RSSI live, packets total, first/last seen, durée active
- **RSSI per sensor** : barre + valeur + distance estimée via path-loss
- **Trilateration block** : coords (x, z) m + distance origine + bearing + residual + confidence + sensors used
- **Velocity** (si position log ≥ 2 pts) : m/s + bearing + indicateur 🏃 fast / 🚶 walking / ⤴ slow
- **Sparkline RSSI** : 60 derniers points, min/avg/max
- **Frame types** : breakdown par kind avec %
- **Live feed** : scroll des 30 derniers paquets de ce device (sid, type color-coded, rssi, channel, length)

### Panneaux flottants (draggables par leur header)

| Icône | Panneau | Contenu |
|---|---|---|
| 📡 | SensorDiagnostics | Per-port : status (`alive`/`garbage`/`stalled`/`ERROR`), baud, bytes/lines/events publiés, rejets détaillés, sid last seen, sensor STA status (✓ associated to `<SSID>`, signal, ch.X), drops, ring free |
| 👤 | PresencePanel | Position centroïde, barre intensity, cross-correlation, barres activity par capteur |
| 📋 | DeviceList | Filtrable, tri stable bucket-é (recent/rssi/packets), ligne par device avec position résolue (2D/1D/~Xm from rN) |
| 🌊 | CSIWaterfall | 64 sous-porteuses × N samples, colormap viridis, filtre solo |
| 💻 | SystemPanel | CPU% global + per-core, temp avec gradient couleur, RAM, load avg, disk /, throttling Pi avec décodage clair |
| ⚙ | ConfigPanel | Liste configs sauvées, scan AP modal (signal bars, channel, sécurité), formulaire add/edit/apply |
| 📏 | CalibrationPanel | Path-loss calibration : sample RSSI à distance connue, régression linéaire sur 3+ points, R², apply au backend |
| 📐 | (toolbar action) | Active le drag des capteurs en 3D pour calibrer leur position physique (verrouille `OrbitControls`) |

### TrilaterationDebug modal (🔍)

Affiche pour le device sélectionné :

1. Table des observations capteurs (capteur, position, RSSI, âge, distance estimée — stale grisés)
2. Modèle path-loss avec formule explicite et constantes
3. Linéarisation : table des coefficients `a₀ a₁ = b` pour chaque pair
4. Équations normales `AᵀA` + `Aᵀb` + déterminant
5. Solution `⟨x, z⟩` m
6. Vérification résidus : distance réelle vs estimée par capteur, couleur (vert <2m, jaune <5m, rouge ≥5m), RMS, confidence
7. Verdict en clair

---

## Configuration WiFi runtime

Workflow simple :

1. Ouvre **⚙ ConfigPanel** dans la toolbar topbar.
2. Clique **🔍 scan APs** → modal avec la liste des APs 2.4 GHz visibles (signal en barres ▰▰▰▱, canal, sécurité).
3. Clique un AP → SSID rempli automatiquement.
4. Renseigne le mot de passe + un nom + 💾 Save → persisté dans `~/wifi-radar-data/wifi-configs.json`.
5. Clique **🚀 Apply** sur la config → backend envoie `{"cmd":"set_wifi", ssid, password}` aux 3 ESPs en UART → ils sauvent en NVS, ack, reboot, reconnect (~3-5 s).
6. Le panneau affiche le **status live de réassociation** par capteur.

Pour pinger les ESPs (test du lien UART) :

```bash
curl -X POST http://realitynauts.local:8000/api/configs/broadcast \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"ping"}'
```

Tu dois voir des events `{"t":"ack","sid":"r0","cmd":"ping","ok":true}` dans le panel diagnostic.

---

## Endpoints REST + WebSocket

### REST

```
GET  /api/stats                       { stats, device_count, csi_buffer_size, sensor_count }
GET  /api/devices                     { devices: [...] (avec position_2d, bilateration, rssi_by_sensor) }
GET  /api/sensors                     { sensors, baseline_half_m }
GET  /api/presence                    { sensor_activity, position, intensity, correlation, history, heatmap }
GET  /api/system                      { cpu_percent, temperature_c, mem_used_pct, throttled_flags, ... }
GET  /api/ports                       { ports: [...] (per-port diagnostic) }
GET  /api/csi/recent?n=64             { csi: [...] }
GET  /api/history/devices?since_minutes=60   (DuckDB)

GET  /api/path-loss                   { rssi_0, n } (current calibration)
POST /api/path-loss                   body { rssi_0, n } → persist + trilateration uses new params
GET  /api/oui-lookup/{mac}            proxy → macvendorlookup.com (cached)

GET  /api/configs                     { configs, active_name }
POST /api/configs                     body { name, ssid, password, notes } → upsert
DELETE /api/configs/{name}
POST /api/configs/{name}/activate     → marque active (ne push pas)
POST /api/configs/{name}/apply        → push aux ESPs, ack via UART, reboot
POST /api/configs/broadcast           body { cmd: "ping" | "reboot" | "get_config" | ... }
GET  /api/aps                         { aps: [...] (scan nmcli) }

POST /api/sensors/{sid}/position      body { x, z } → persiste, override auto-layout
DELETE /api/sensors/{sid}/position    → repasse en auto-layout pour ce capteur
```

### WebSocket

```
ws://<pi>:8000/ws
```

À la connexion : `{ t: "snapshot", devices, stats, sensors, baseline_half_m, presence, ports, system }`

En live :
- `{ t: "sniff" | "csi" | "hb" | "ack", sid, ... }` (events bruts du bus)
- `{ t: "stats", ..., sensors, presence, ports, system }` (push 1 Hz avec tout l'état dérivé)

---

## Formats de données

### Sniff event

```json
{ "t":"sniff", "sid":"r0", "k":"probe-req", "rssi":-68, "ch":13,
  "src":"38ca8489f493", "dst":"ffffffffffff", "len":124, "ts":1742670182.341 }
```

### CSI event

```json
{ "t":"csi", "sid":"r0", "src":"e84e06323720", "rssi":-21, "ch":13, "len":128,
  "data":[-53,-80,12,0,-29,-10,...], "ts":1742670182.412 }
```

`data` = `[imag_0, real_0, imag_1, real_1, …, imag_63, real_63]` int8. Amplitude sous-porteuse k = `sqrt(data[2k]² + data[2k+1]²)`.

### Heartbeat

```json
{ "t":"hb", "sid":"r0", "connected":true, "ssid":"bq-radar", "rssi":-21, "ch":13,
  "drops":0, "ring_free":15876, "ts":1742670190.001 }
```

### Command ack

```json
{ "t":"ack", "sid":"r0", "cmd":"set_wifi", "ok":true, "detail":"saved, rebooting" }
```

---

## Persistence

Tous les events sniff + CSI sont flushés par batch 5 s dans **DuckDB** `~/wifi-radar-data/radar.duckdb`. Rotation horaire vers `~/wifi-radar-data/parquet/sniff_*.parquet` et `csi_*.parquet` ZSTD.

Le fichier `~/wifi-radar-data/wifi-configs.json` regroupe tout l'état non-événementiel persistant :

```json
{
  "configs": [ ... ],                  // WiFi configs sauvées
  "active_name": "Home WiFi",          // config courante
  "sensor_positions": [                // calibration drag-and-drop 📐
    { "sid": "r0", "x": -1.73, "z": 1.0 },
    { "sid": "r1", "x":  1.73, "z": 1.0 },
    { "sid": "r2", "x":  0.0,  "z": -2.0 }
  ],
  "path_loss": { "rssi_0": -32.4, "n": 2.78 }   // calibration 📏
}
```

```sql
-- Requête sur l'historique long (CLI duckdb) :
SELECT src_mac, COUNT(*) AS pkts, AVG(rssi) AS avg_rssi
FROM read_parquet('~/wifi-radar-data/parquet/sniff_*.parquet')
GROUP BY src_mac ORDER BY 2 DESC LIMIT 20;
```

---

## Dépannage

### `Input/output error` sur tous les `/dev/ttyUSB*` simultanément

Surcharge USB du Pi (3 ESP + dongle dépassent ~600 mA). Brancher les ESPs **directement** sur les ports Pi (pas via hub passif) ou utiliser un **hub USB alimenté externe**.

### Backend reçoit 0 events / sensor "?" phantom

Whitelist stricte requiert `t ∈ {sniff,csi,hb,ack}` + `sid` non vide. Si tu vois encore un `?`, vérifie que `serial_reader.py` a bien le check `sid` (présent depuis commit fix).

### STA ne s'associe pas (`connected: false`, ch.0)

L'AP `bq-radar` (dongle Realtek) est probablement tombé. Vérifier :

```bash
nmcli connection show bq-radar | grep -E '(STATE|802-11-wireless)'
iw dev <dongle> info | grep type   # doit être "AP" si AP up
sudo nmcli connection up bq-radar  # relance si down
```

Alternative robuste : utiliser un **vrai routeur secondaire** ou ta box internet, configurer via ⚙ ConfigPanel.

### Le baud 921600 ne tient pas après flash

`sdkconfig.defaults` perd parfois face à d'autres Kconfig choices. `flash_sid.sh` patche le `sdkconfig` après `set-target` pour forcer.

### Frontend reste sur "connecting"

DevTools réseau → la requête `ws://...` doit revenir en `101 Switching Protocols`. Vérifie le hostname + reverse proxy (Upgrade/Connection headers).

### Drops massifs (`drops` > 1000/s sur un capteur)

UART à 115200 sature à ~14 KB/s. Passe à 921600 (firmware via Kconfig ou patch sdkconfig, backend `RADAR_BAUD=921600`). Ou filtre côté firmware en réduisant les data frames captés.

### `WebGL context creation failed` (Firefox surtout)

Fuite de contextes WebGL après reload multiples. Ferme tous les onglets de l'app, **redémarre complètement le navigateur** (kill process). Alternative : utiliser Chrome/Edge si Firefox bloque.

### Positions trilatération aberrantes (résidus > 10 m)

- Baseline capteurs trop court → augmente la distance entre ESPs
- Path-loss model désaligné → calibre via le panneau **📏** in situ (3+ points à distances connues)
- Capteurs colinéaires → bouge-en un hors de l'axe
- Filtre la confiance dans le frontend (déjà fait : opacity réduite si confidence basse)

---

## Honnêteté du code — ce qui est réel vs décoratif

Pour rester transparent sur ce qui est mesuré vs deviné :

### 🟢 Réel et fiable
- Sniff events (MAC, RSSI, type, channel)
- CSI events (128 bytes par event, int8)
- Heartbeats firmware (SSID associé, channel, RSSI vers AP, drops)
- OUI vendor lookup (DB 38k+ entrées)
- Pi system stats (`/proc`, `/sys`, `vcgencmd`)
- Persistence DuckDB + parquet
- Auto-baud (test des bytes reçus)
- Trilatération moindres carrés (math correcte)
- Bilatération géométrique (math correcte)

### 🟡 Approximations heuristiques
- Path-loss constants — défaut `RSSI_0 = -30, n = 2.5`, **calibratable in situ via 📏** (régression linéaire). Sans calibration, ±50 % d'erreur indoor.
- Confiance trilatération `exp(-residual/8) × ...` — empirique
- Centroïde de présence pondéré par activity — pas une estimation bayésienne
- Variance CSI = somme des `|a[j]-b[j]|` — pas la vraie variance complexe
- Cross-correlation Pearson sur activity — fonctionne mais grossier
- Seuil `NOISE_FLOOR = 30` pour la présence — magic number

### 🟠 Fake assumé, marqué visuellement
- Angle des devices avec 1 capteur seulement → hash MAC, **opacité 22 %**
- Angle des devices avec 0 capteur frais → orbit origin, **opacité 15 %**
- Devices avec position 2D fake = nettement plus fade visuellement que les trilaterés

### 🔴 À calibrer (UI fournie, persisté côté backend)
- **Positions physiques des capteurs** — mode 📐 drag-and-drop ; sinon auto-layout triangle théorique
- **Path-loss params** — panneau 📏 in situ : sample 5s + régression linéaire sur ≥3 points
- **AP cible** — NVS persisté côté ESP32, configurable via ⚙ (push UART instantané)

---

## Structure du projet

```
wifi-radar/
├── README.md
├── firmware/
│   ├── CMakeLists.txt
│   ├── sdkconfig.defaults
│   ├── flash_sid.sh             # build + flash + restore SID (no backend restart)
│   └── main/
│       ├── CMakeLists.txt
│       ├── Kconfig.projbuild    # SENSOR_ID, WiFi defaults, UART baud
│       └── radar_main.c         # init, sniffer, CSI, ringbuf, drainer,
│                                # NVS load/store, cmd_listener_task
│
├── backend/
│   ├── pyproject.toml
│   └── app/
│       ├── main.py              # FastAPI lifespan + auto-glob serial readers
│       ├── event_bus.py         # asyncio pub/sub
│       ├── serial_reader.py     # async per-port reader, auto-baud rotation
│       ├── serial_writer.py     # outbound JSON commands → ESP UART
│       ├── state.py             # devices, sensors auto-layout + calibration,
│       │                        # bilateration, trilateration LSQ
│       ├── presence.py          # CSI variance window, centroid, correlation,
│       │                        # rolling trail history, heatmap grid + decay
│       ├── persistence.py       # DuckDB batch + parquet hourly roll
│       ├── system_stats.py      # /proc, /sys, vcgencmd
│       ├── oui.py               # MAC vendor lookup (dict préchargé)
│       ├── config.py            # JSON-backed WiFi configs + sensor positions
│       ├── api.py               # REST endpoints
│       └── ws.py                # WebSocket snapshot + 1 Hz push
│
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig*.json
    ├── tailwind.config.js
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── lib/
        │   ├── types.ts                  # Device, Sensor, PresenceState,
        │   │                             # WifiConfig, SystemStats, PortStats...
        │   ├── ws.ts                     # WS client + reconnect
        │   ├── colors.ts                 # hash MAC, rssiToDistance (real m),
        │   │                             # rssiToRadius (clamp 0.5-15m), withAlpha
        │   ├── useThrottled.ts           # snapshot throttle hook
        │   ├── useDraggable.ts           # pointer drag hook for panels
        │   └── trilaterationDebug.ts     # step-by-step math for the modal
        ├── store/
        │   └── index.ts                  # Zustand store (devices, sensors,
        │                                 # presence, ports, system, configs,
        │                                 # panel visibility, calibration mode)
        ├── three/
        │   ├── Floor.tsx                 # 1m grid + axes XZ gradués + range labels
        │   ├── SensorNode.tsx            # capteur 3D avec halo + label SSID
        │   ├── SensorDraggable.tsx       # wrapper drag-on-floor en mode calib
        │   ├── DeviceOrbit.tsx           # device 3D, opacity = certainty
        │   ├── CSIField.tsx              # particules réactives variance CSI
        │   ├── RangeRings.tsx            # anneaux concentriques
        │   ├── PresenceBlob.tsx          # blob lumineux centroïde
        │   ├── MotionTrail.tsx           # line strip historique présence
        │   ├── HeatmapFloor.tsx          # DataTexture grid au sol accumulée
        │   └── SelectedDeviceTrail.tsx   # trail du device sélectionné
        └── components/
            ├── Scene3D.tsx               # Canvas R3F + montage scène + camera focus
            ├── StatsBar.tsx              # topbar pills + ViewToolbar
            ├── ViewToolbar.tsx           # toggle panneaux + mode calibration
            ├── DeviceList.tsx            # liste filtrable, ligne avec position
            ├── DeviceDetail.tsx          # panel détail au clic (draggable, scroll)
            ├── TrilaterationDebug.tsx    # modal step-by-step (responsive)
            ├── PresencePanel.tsx         # intensity, correlation, activity
            ├── SensorDiagnostics.tsx     # diagnostic per-port + per-sensor
            ├── SystemPanel.tsx           # Pi resources (CPU/temp/RAM/throttle)
            ├── ConfigPanel.tsx           # WiFi configs CRUD + scan APs modal
            ├── CalibrationPanel.tsx      # Path-loss calibration (sample + fit + apply)
            └── CSIWaterfall.tsx          # 64 subcarriers × N samples
```

---

## Roadmap

| Étape | Apport | Statut |
|---|---|---|
| Path-loss in situ calibration UI | meilleure conversion RSSI → distance | ✅ done (panneau 📏) |
| Mobile / portrait UI | tablette, smartphone | ✅ done (responsive breakpoints) |
| Sensor position calibration (drag) | trilatération basée sur les vraies positions | ✅ done (mode 📐) |
| Ping périodique ESP32 → Pi (firmware) | CSI à 50 Hz pour détection mouvement fine | pending |
| FFT 0.1–0.5 Hz sur amplitude CSI | détection de **respiration** | pending (besoin du ping périodique avant) |
| Clustering DBSCAN sur positions | grouper plusieurs corps en mouvement | pending |
| Export Prometheus | dashboards Grafana | pending (facile) |
| Sensor height calibration (3D) | trilatération 3D vraie | pending (gros) |
| TF Lite micro on-device | inférence ML présent/absent | pending (très gros) |

---

## Licence

GPLv3
