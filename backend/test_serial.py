import asyncio
import serial_asyncio_fast as sa


class P(asyncio.Protocol):
    def connection_made(self, transport):
        print("CONNECTED", flush=True)

    def data_received(self, data):
        snippet = data[:80]
        print("GOT", len(data), "bytes:", snippet, flush=True)


async def main():
    loop = asyncio.get_running_loop()
    await sa.create_serial_connection(loop, P, "/dev/ttyUSB0", baudrate=115200)
    await asyncio.sleep(4)


asyncio.run(main())
