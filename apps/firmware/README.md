# Claudette firmware

ESP32-S3 firmware for the Claudette desk display. It's built with PlatformIO, the Arduino core 2.0.17 and LVGL 9.6, and it draws with the shared UI in `packages/lvgl-ui`.

Target board: **Freenove FNK0104S**, a 4.0" ESP32-S3 display. It has an ESP32-S3-WROOM N16R8 (16 MB flash, 8 MB octal PSRAM), an ST7796 320×480 SPI panel and an FT6336U touch controller.

## Build, flash, monitor

You need [PlatformIO Core](https://platformio.org/install/cli) (`pio`). The first build downloads the toolchain, which is a few hundred MB.

```bash
cd apps/firmware
pio run -e freenove-s3-4in              # build            (pnpm build)
pio run -e freenove-s3-4in -t upload    # flash over USB   (pnpm flash)
pio device monitor                      # serial, 115200   (pnpm monitor)
pnpm merge                              # dist/claudette-freenove-s3-4in.bin + .sha256
```

`pnpm merge` combines the bootloader, partition table, boot_app0 and the app into a single image. The image goes at offset `0x0`. Use it in the browser installer (`web-flasher/manifest.json`, ESP Web Tools format) or flash it directly:

```bash
esptool.py --chip esp32s3 write_flash 0x0 dist/claudette-freenove-s3-4in.bin
```

If upload can't find the port, hold **BOOT**, tap **RST**, release BOOT, and run upload again.

`pio run -e stub` builds the same firmware against plain placeholder screens (`src/dev_stub_ui.c`) instead of the shared UI. It's useful for bringing up the hardware and the network. Don't ship it.

## First boot

1. The screen shows a setup hotspot named `Claudette-XXXX`, with a random password and a QR code. Join it from your phone. The setup page opens on its own; if it doesn't, go to <http://192.168.4.1>.
2. Pick your Wi-Fi network and enter its password. If your network blocks discovery (office or guest Wi-Fi), open "Can't find your Mac automatically?" and type your Mac's IP or `name.local` and the port (default 3333).
3. The display restarts, joins your Wi-Fi and looks for `_claudette._tcp`. Tap your Mac.
4. The display shows a 6-digit code. Type it into <http://localhost:3333> on the Mac. The display then shows the dashboard.

## Recovery

| What | How |
|---|---|
| Re-run Wi-Fi / address setup (keeps pairing) | Hold **BOOT** for 3 s and let go, or send `setup` over serial |
| Forget the Mac and pair again | Settings → "Pair with another Mac", or send `forget` over serial |
| Factory reset (wipes Wi-Fi, pairing, preferences) | Settings → Factory reset, hold **BOOT** for 10 s, or send `factory-reset` over serial |

Serial commands at 115200 baud, ending with Enter: `status`, `setup`, `reconnect`, `forget`, `factory-reset`, `reboot`, `touch` (logs touch coordinates). The log never contains the Wi-Fi password, the device token, the pairing secret or the pairing code.

## Pins (FNK0104S)

| Function | GPIO |
|---|---|
| LCD SCLK / MOSI / MISO | 12 / 11 / 13 |
| LCD CS / DC / RST | 10 / 46 / – |
| Backlight (PWM, active high) | 45 |
| Touch SDA / SCL | 16 / 15 |
| Touch INT / RST (FT6336U @ 0x38) | 17 / 18 |
| BOOT button | 0 |

## Another board

Every pin and panel option lives in `include/board_config.h`, behind `#ifndef`. To support another board:

1. Copy the `[env:freenove-s3-4in]` block in `platformio.ini` to a new env.
2. Override the values that differ with `build_flags`, for example `-DLCD_PIN_DC=7 -DTOUCH_INVERT_X=1`.
3. If the board uses a different panel or touch controller, change the driver classes in `src/hal_display.cpp`. The UI assumes a 320×480 portrait screen.

Boards without PSRAM still run, but the snapshot buffers fall back to internal RAM.

## Troubleshooting

- **Colours look inverted (like a photo negative).** Flip `LCD_INVERT`. If red and blue are swapped, flip `LCD_RGB_ORDER`.
- **Colours look like speckled noise.** The RGB565 byte order is wrong: set `-DLCD_SWAP_BYTES=0`.
- **Touch lands in the wrong place.** Send `touch` over serial and tap the corners. If the taps are mirrored left/right, set `-DTOUCH_INVERT_X=1`; if they're mirrored up/down, set `-DTOUCH_INVERT_Y=1`. If moving your finger right registers as moving down, set `-DTOUCH_SWAP_XY=1`. `TOUCH_ROTATION` (0–7) is LovyanGFX's own offset.
- **The boot log says "no PSRAM detected", or the board boot-loops right after flashing.** Keep `board_build.arduino.memory_type = dio_opi` and `board_build.flash_mode = dio`. N16R8 modules use octal PSRAM, and forcing QIO flash has been reported to hang the ROM bootloader.
- **The display is garbled or flickers.** Lower `LCD_SPI_FREQ_WRITE`. It defaults to 40 MHz; 80 MHz usually works too.
- **Nothing on serial.** This build logs over the native USB CDC port (`ARDUINO_USB_CDC_ON_BOOT=1`). If your board's USB-C goes through a USB-UART bridge, set `-DARDUINO_USB_CDC_ON_BOOT=0`.
- **The display can't find the Mac.** Check that the Mac and the display are on the same network and subnet, and that the Mac's firewall allows Node to accept incoming connections. If the network blocks discovery, use the manual address field in setup.
