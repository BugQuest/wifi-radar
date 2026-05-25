import asyncio
from mac_vendor_lookup import AsyncMacLookup, MacLookup


async def main():
    a = AsyncMacLookup()
    await a.load_vendors()
    print("prefixes count:", len(a.prefixes))
    print("sample:", list(a.prefixes.items())[:3])
    print("lookup:", a.prefixes.get(b"D48AFC"))
    print("lookup str:", a.prefixes.get("D48AFC"))

asyncio.run(main())

# Sync side
m = MacLookup()
for mac in ["D4:8A:FC:A1:92:F4", "E8:4E:06:32:37:20", "38:CA:84:89:F4:93"]:
    try:
        print(mac, "->", m.lookup(mac))
    except Exception as e:
        print(mac, "->", "ERROR:", type(e).__name__, e)
