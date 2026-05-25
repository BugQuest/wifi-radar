from mac_vendor_lookup import MacLookup, AsyncMacLookup
import inspect

ml = MacLookup()
print("MacLookup.lookup is coro:", inspect.iscoroutinefunction(ml.lookup))
print("Methods:", [m for m in dir(ml) if not m.startswith("_")])

aml = AsyncMacLookup()
print("AsyncMacLookup.lookup is coro:", inspect.iscoroutinefunction(aml.lookup))
print("Async methods:", [m for m in dir(aml) if not m.startswith("_")])

# Try sync lookup
try:
    r = ml.lookup("D4:8A:FC:A1:92:F4")
    print("Sync result:", r, type(r))
except Exception as e:
    print("Sync failed:", e)
