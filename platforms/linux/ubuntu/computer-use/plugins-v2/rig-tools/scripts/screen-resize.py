#!/usr/bin/env python3
"""Attach briefly to one GNU Screen session to set its terminal dimensions."""

from __future__ import annotations

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import termios
import time


NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("name")
    parser.add_argument("columns", type=int)
    parser.add_argument("rows", type=int)
    args = parser.parse_args()
    if not NAME.fullmatch(args.name):
        parser.error("invalid session name")
    if not 40 <= args.columns <= 240 or not 16 <= args.rows <= 100:
        parser.error("dimensions outside allowed bounds")

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("screen", ["screen", "-r", args.name])

    try:
        size = struct.pack("HHHH", args.rows, args.columns, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
        os.kill(pid, signal.SIGWINCH)
        deadline = time.monotonic() + 3
        attached = False
        while time.monotonic() < deadline:
            readable, _, _ = select.select([fd], [], [], 0.1)
            if readable:
                try:
                    os.read(fd, 65536)
                    attached = True
                except OSError:
                    break
            if attached:
                break
        os.write(fd, b"\x01d")
        wait_deadline = time.monotonic() + 2
        while time.monotonic() < wait_deadline:
            result, status = os.waitpid(pid, os.WNOHANG)
            if result == pid:
                return os.waitstatus_to_exitcode(status)
            time.sleep(0.05)
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        return 1
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
