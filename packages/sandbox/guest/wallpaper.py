#!/usr/bin/env python3
import sys

WIDTH = 1280
HEIGHT = 800
TOP = (22, 24, 30)
BOTTOM = (56, 61, 78)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/openbot-wallpaper.ppm"
    row = bytearray()
    with open(path, "wb") as handle:
        handle.write(b"P6\n%d %d\n255\n" % (WIDTH, HEIGHT))
        for y in range(HEIGHT):
            t = y / (HEIGHT - 1)
            pixel = bytes(
                (
                    int(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
                    int(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
                    int(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
                )
            )
            row.clear()
            row.extend(pixel * WIDTH)
            handle.write(row)


if __name__ == "__main__":
    main()
