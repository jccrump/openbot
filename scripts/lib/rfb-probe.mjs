import assert from "node:assert/strict";

class ByteReader {
  #buffers = [];
  #length = 0;
  #waiters = new Set();
  #error = null;

  push(value) {
    const buffer = Buffer.from(value);
    if (buffer.length === 0) return;
    this.#buffers.push(buffer);
    this.#length += buffer.length;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  fail(error) {
    this.#error = error;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async read(length, deadline) {
    while (this.#length < length) {
      if (this.#error) throw this.#error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${length} RFB bytes`);
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#waiters.delete(wake);
          reject(new Error(`timed out waiting for ${length} RFB bytes`));
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#waiters.add(wake);
      });
    }

    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const first = this.#buffers[0];
      const take = Math.min(first.length, length - offset);
      first.copy(output, offset, 0, take);
      offset += take;
      this.#length -= take;
      if (take === first.length) {
        this.#buffers.shift();
      } else {
        this.#buffers[0] = first.subarray(take);
      }
    }
    return output;
  }
}

function send(socket, bytes) {
  socket.send(bytes instanceof Buffer ? bytes : Buffer.from(bytes));
}

export async function probeRfbFramebuffer(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const reader = new ByteReader();
  socket.addEventListener("message", (event) => reader.push(event.data));
  socket.addEventListener("close", (event) => {
    reader.fail(
      new Error(`RFB WebSocket closed (${event.code} ${event.reason || "no reason"})`),
    );
  });
  socket.addEventListener("error", () => {
    reader.fail(new Error("RFB WebSocket failed"));
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out opening RFB WebSocket")),
        timeoutMs,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("could not open RFB WebSocket"));
        },
        { once: true },
      );
    });

    const version = await reader.read(12, deadline);
    assert.match(version.toString("ascii"), /^RFB 003\.00[378]\n$/);
    send(socket, version);

    const securityCount = (await reader.read(1, deadline))[0];
    assert.ok(securityCount > 0, "RFB server offered no security types");
    const securityTypes = await reader.read(securityCount, deadline);
    assert.ok(securityTypes.includes(1), "RFB server did not offer None security");
    send(socket, [1]);
    const securityResult = (await reader.read(4, deadline)).readUInt32BE(0);
    assert.equal(securityResult, 0, "RFB security negotiation failed");

    send(socket, [1]); // shared ClientInit
    const serverInit = await reader.read(24, deadline);
    const width = serverInit.readUInt16BE(0);
    const height = serverInit.readUInt16BE(2);
    const bytesPerPixel = serverInit[4] / 8;
    const nameLength = serverInit.readUInt32BE(20);
    const name = (await reader.read(nameLength, deadline)).toString("utf8");
    assert.ok(width > 0 && height > 0, "RFB server reported an empty desktop");
    assert.ok(bytesPerPixel > 0 && bytesPerPixel <= 4, "invalid RFB pixel format");

    const encodings = Buffer.alloc(8);
    encodings[0] = 2; // SetEncodings
    encodings.writeUInt16BE(1, 2);
    encodings.writeInt32BE(0, 4); // Raw
    send(socket, encodings);

    const update = Buffer.alloc(10);
    update[0] = 3; // FramebufferUpdateRequest
    update[1] = 0; // non-incremental
    update.writeUInt16BE(width, 6);
    update.writeUInt16BE(height, 8);
    send(socket, update);

    while (Date.now() < deadline) {
      const messageType = (await reader.read(1, deadline))[0];
      if (messageType === 2) continue; // Bell
      if (messageType === 3) {
        await reader.read(3, deadline);
        const length = (await reader.read(4, deadline)).readUInt32BE(0);
        await reader.read(length, deadline);
        continue;
      }
      assert.equal(messageType, 0, `unexpected RFB server message ${messageType}`);
      const updateHeader = await reader.read(3, deadline);
      const rectangleCount = updateHeader.readUInt16BE(1);
      for (let index = 0; index < rectangleCount; index += 1) {
        const rectangle = await reader.read(12, deadline);
        const rectangleWidth = rectangle.readUInt16BE(4);
        const rectangleHeight = rectangle.readUInt16BE(6);
        const encoding = rectangle.readInt32BE(8);
        assert.equal(encoding, 0, `RFB server ignored requested Raw encoding (${encoding})`);
        const pixelBytes = rectangleWidth * rectangleHeight * bytesPerPixel;
        assert.ok(pixelBytes > 0, "RFB server sent an empty framebuffer rectangle");
        await reader.read(pixelBytes, deadline);
        return {
          protocol: version.toString("ascii").trim(),
          width,
          height,
          name,
          rectangleWidth,
          rectangleHeight,
          pixelBytes,
        };
      }
    }
    throw new Error("RFB server did not send a framebuffer rectangle");
  } finally {
    socket.close();
  }
}
