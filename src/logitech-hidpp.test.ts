import assert from "node:assert/strict";
import test from "node:test";

import { LogitechHidppClient, LOGITECH_RECEIVER_PRODUCT_IDS } from "./logitech-hidpp.ts";

const SHORT_REPORT_ID = 0x10;
const LONG_REPORT_ID = 0x11;

const FEATURE_INDEX = new Map([
  [0x0003, 0x02],
  [0x0005, 0x01],
  [0x1000, 0x03],
  [0x2201, 0x04],
  [0x8060, 0x05],
  [0x8100, 0x06],
]);

class FakeG604Receiver extends EventTarget {
  readonly vendorId = 0x046d;
  readonly productId = 0xc539;
  readonly productName = "USB Receiver";
  readonly collections = [{
    usagePage: 0xff00,
    usage: 0x0001,
    inputReports: [],
    outputReports: [],
    featureReports: [],
    children: [],
  }];
  opened = false;
  dpi = 800;
  pollingPeriodMs = 1;

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendFeatureReport(): Promise<void> {}

  async receiveFeatureReport(): Promise<DataView> {
    return new DataView(new ArrayBuffer(0));
  }

  async sendReport(_reportId: number, data: BufferSource): Promise<void> {
    const request = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const featureIndex = request[1] ?? 0;
    const functionId = request[2] ?? 0;
    const payload = this.handle(featureIndex, functionId, request.slice(3));
    queueMicrotask(() => this.respond(featureIndex, functionId, payload));
  }

  private handle(featureIndex: number, functionId: number, parameters: Uint8Array): number[] {
    if (featureIndex === 0x00 && functionId === 0x00) {
      const featureId = ((parameters[0] ?? 0) << 8) | (parameters[1] ?? 0);
      return [FEATURE_INDEX.get(featureId) ?? 0, 0x00, 0x00];
    }
    if (featureIndex === 0x01 && functionId === 0x00) return ["G604 LIGHTSPEED".length];
    if (featureIndex === 0x01 && functionId === 0x10) {
      const name = new TextEncoder().encode("G604 LIGHTSPEED");
      return [...name.slice(parameters[0] ?? 0, (parameters[0] ?? 0) + 16)];
    }
    if (featureIndex === 0x02 && functionId === 0x00) {
      return [1, 0x12, 0x34, 0x56, 0x78, 0, 0x05, 0xb0, 0x24, 0x40, 0x85, 0, 0];
    }
    if (featureIndex === 0x02 && functionId === 0x10) return [0, 0x4d, 0x50, 0x4d, 0x39, 0x06];
    if (featureIndex === 0x03 && functionId === 0x00) return [75, 70, 0x00];
    if (featureIndex === 0x04 && functionId === 0x10) {
      return [0, 0x00, 0x64, 0xe0, 0x32, 0x3e, 0x80, 0x00, 0x00];
    }
    if (featureIndex === 0x04 && functionId === 0x20) {
      return [0, this.dpi >> 8, this.dpi & 0xff, 0x03, 0x20];
    }
    if (featureIndex === 0x04 && functionId === 0x30) {
      this.dpi = ((parameters[1] ?? 0) << 8) | (parameters[2] ?? 0);
      return [];
    }
    if (featureIndex === 0x05 && functionId === 0x00) return [0x8b];
    if (featureIndex === 0x05 && functionId === 0x10) return [this.pollingPeriodMs];
    if (featureIndex === 0x05 && functionId === 0x20) {
      this.pollingPeriodMs = parameters[0] ?? this.pollingPeriodMs;
      return [];
    }
    if (featureIndex === 0x06 && functionId === 0x20) return [0x02];
    throw new Error(`Unexpected HID++ request ${featureIndex.toString(16)}:${functionId.toString(16)}`);
  }

  private respond(featureIndex: number, functionId: number, payload: number[]): void {
    const report = new Uint8Array(Math.max(6, payload.length + 3));
    report.set([0x01, featureIndex, functionId]);
    report.set(payload, 3);
    const event = new Event("inputreport");
    Object.defineProperties(event, {
      reportId: { value: payload.length > 3 ? LONG_REPORT_ID : SHORT_REPORT_ID },
      data: { value: new DataView(report.buffer) },
      device: { value: this },
    });
    this.dispatchEvent(event);
  }
}

function createClient(device = new FakeG604Receiver()): { client: LogitechHidppClient; device: FakeG604Receiver } {
  // SAFETY: The fake implements the HIDDevice surface exercised by LogitechHidppClient.
  const hidDevice = device as unknown as HIDDevice;
  return { client: new LogitechHidppClient(hidDevice), device };
}

test("recognizes the G604 receiver only on its HID++ collection", () => {
  const { device } = createClient();
  // SAFETY: The fake implements the HIDDevice identity and collection fields used by isSupported.
  const hidDevice = device as unknown as HIDDevice;
  assert.equal(LOGITECH_RECEIVER_PRODUCT_IDS.includes(0xc539), true);
  assert.equal(LogitechHidppClient.isSupported(hidDevice), true);
  Object.defineProperty(device, "collections", { value: [] });
  assert.equal(LogitechHidppClient.isSupported(hidDevice), false);
});

test("reads G604 status through standard HID++ capabilities", async () => {
  const { client } = createClient();
  const status = await client.readStatus();

  assert.equal(status.name, "G604 LIGHTSPEED");
  assert.equal(status.batteryPercent, 75);
  assert.equal(status.dpi, 800);
  assert.equal(status.dpiY, 800);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.supportsSeparateDpiAxes, false);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [1000, 500, 250, 125]);
  assert.equal(status.deviceMode, "Host");
  assert.equal(status.unitId, "12345678");
  assert.deepEqual(status.transportIds, { Bluetooth: "B024", Wireless: "4085" });
});

test("reads and writes G604 DPI through feature 0x2201", async () => {
  const { client, device } = createClient();
  assert.deepEqual(await client.getDpiOptions(), Array.from({ length: 319 }, (_unused, index) => 100 + index * 50));
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(device.dpi, 1600);
  await assert.rejects(() => client.setDpi(1600, 800), /does not support separate X\/Y DPI/);
});

test("reads and writes G604 report rate through feature 0x8060", async () => {
  const { client, device } = createClient();
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(device.pollingPeriodMs, 2);
  await assert.rejects(() => client.setPollingRate(2000), /Unsupported polling rate/);
});
