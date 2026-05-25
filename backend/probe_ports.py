import serial
import sys

for port in ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyUSB2"]:
    for baud in [921600, 115200]:
        try:
            s = serial.Serial(port, baud, timeout=1.5)
            data = s.read(512)
            s.close()
            text = data.decode("utf-8", errors="replace")
            # Find a JSON-looking start
            i = text.find('{"t":"')
            snippet = text[i:i+120] if i >= 0 else "(no JSON start)"
            print(f"{port} @ {baud}: {len(data)} bytes — {snippet}")
        except Exception as e:
            print(f"{port} @ {baud}: ERR {e}")
