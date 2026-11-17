#!/usr/bin/env python3
"""
Điều khiển trang Google Colab bằng Playwright để khởi động phiên mới và "Run all".
Notebook chạy trên runtime của Google – trình duyệt local chỉ đóng vai trò bấm nút
và giữ tab mở (Colab cần tab mở để phiên không bị ngắt vì idle).

  python colab_driver.py --url <colab_url> --profile ./.colab-profile [--login] [--headless]

Mã thoát: 0 = đóng bình thường, 2 = chưa đăng nhập Google, 3 = runtime bị ngắt.
"""
import argparse
import re
import sys
import time

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

# Các nút có thể hiện ra sau khi Run all (EN + VI)
DIALOG_BUTTONS = [
    r"^Run anyway$", r"^Vẫn chạy$", r"^Chạy bất kể$",
    r"^Connect without GPU$", r"^Kết nối không có GPU$",
    r"^Connect to a CPU runtime$",
    r"^Yes$", r"^OK$",
]
DISCONNECTED_TEXT = re.compile(r"(Runtime disconnected|Đã ngắt kết nối thời gian chạy|Cannot connect to)", re.I)


def log(msg):
    print(msg, flush=True)


def click_dialogs(page, seconds=120):
    """Bấm các hộp thoại xác nhận trong khoảng thời gian cho trước."""
    end = time.time() + seconds
    while time.time() < end:
        for pat in DIALOG_BUTTONS:
            btn = page.get_by_role("button", name=re.compile(pat, re.I))
            try:
                if btn.count() and btn.first.is_visible():
                    name = btn.first.inner_text().strip()
                    btn.first.click(timeout=2000)
                    log(f"Đã bấm nút: {name}")
            except Exception:
                pass
        time.sleep(2)


def run_all(page):
    page.locator("body").click(position={"x": 400, "y": 300})
    mod = "Meta" if sys.platform == "darwin" else "Control"
    page.keyboard.press(f"{mod}+F9")
    log("Đã gửi Run all (Ctrl/Cmd+F9)")
    time.sleep(3)
    # Dự phòng: dùng menu Runtime → Run all nếu phím tắt không ăn
    try:
        if not page.locator("colab-run-button[running], .cell.running, .running").count():
            page.get_by_role("menuitem", name=re.compile(r"^(Runtime|Thời gian chạy)$")).click(timeout=4000)
            page.get_by_role("menuitem", name=re.compile(r"^(Run all|Chạy tất cả)")).click(timeout=4000)
            log("Run all qua menu")
    except Exception:
        pass


def main():
    for stream in (sys.stdout, sys.stderr):  # Windows: tránh UnicodeEncodeError khi in tiếng Việt
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--profile", required=True)
    ap.add_argument("--channel", default="")
    ap.add_argument("--login", action="store_true", help="Chỉ mở để đăng nhập Google, không Run all")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--keepalive-sec", type=int, default=240)
    a = ap.parse_args()

    with sync_playwright() as p:
        kw = dict(user_data_dir=a.profile, headless=a.headless, viewport={"width": 1366, "height": 860},
                  args=["--disable-blink-features=AutomationControlled"])
        if a.channel:
            kw["channel"] = a.channel
        ctx = p.chromium.launch_persistent_context(**kw)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        if a.login:
            page.goto("https://accounts.google.com/")
            log("Hãy đăng nhập Google trong cửa sổ vừa mở, rồi đóng cửa sổ.")
            page.wait_for_event("close", timeout=0)
            return 0

        page.goto(a.url, wait_until="domcontentloaded")
        try:
            page.wait_for_selector("colab-connect-button, #connect", timeout=60000)
        except PWTimeout:
            pass
        if "accounts.google.com" in page.url or page.get_by_text(re.compile(r"^Sign in$")).count():
            log("ERR chưa đăng nhập Google – bấm 'Đăng nhập Google' trên webapp")
            return 2

        time.sleep(5)
        run_all(page)
        click_dialogs(page, seconds=120)
        log("Notebook đang chạy trên Colab – giữ tab mở để tránh idle timeout")

        # Giữ tab sống + phát hiện runtime bị ngắt
        while True:
            try:
                page.mouse.move(300 + int(time.time()) % 200, 300)
                page.mouse.wheel(0, 1)
                if page.get_by_text(DISCONNECTED_TEXT).count():
                    log("WARN runtime đã bị ngắt kết nối")
                    return 3
            except Exception as e:
                if page.is_closed():
                    log("Tab Colab đã bị đóng")
                    return 0
                log(f"WARN keepalive: {e}")
            time.sleep(a.keepalive_sec)


if __name__ == "__main__":
    sys.exit(main())
