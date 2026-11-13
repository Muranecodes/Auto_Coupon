import argparse
import json
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI_PATH = REPO_ROOT / "src" / "scraper" / "cli.ts"
STATE_FILE = REPO_ROOT / ".last_scrape_date"
LOG_FILE = REPO_ROOT / "logs" / "daily_scrape.log"

FALLBACK_SOURCES = [
    {
        "platform": "foodpanda",
        "url": "https://www.callingtaiwan.com.tw/foodpanda-coupon-code/",
    },
    {
        "platform": "ubereats",
        "url": "https://www.callingtaiwan.com.tw/ubereats%E5%84%AA%E6%83%A0-%E6%9C%80%E6%96%B0%E9%A4%90%E5%BB%B3%E5%A4%96%E9%80%81%E9%A6%96%E8%B3%BC%E5%84%AA%E6%83%A0%E5%BA%8F%E8%99%9F-%E6%8A%98%E6%89%A3%E7%A2%BC-%E6%8E%A8%E8%96%A6%E7%A2%BC/",
    },
]


def _subprocess_kwargs() -> dict:
    kwargs: dict = {"cwd": str(REPO_ROOT), "capture_output": True, "text": True, "encoding": "utf-8"}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kwargs


def log(msg: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    try:
        print(line)
    except Exception:
        pass
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def wait_for_network(timeout_sec: int = 90) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            with socket.create_connection(("www.callingtaiwan.com.tw", 443), timeout=5):
                return True
        except OSError:
            time.sleep(5)
    return False


def load_scraper_sources() -> list[dict[str, str]]:
    try:
        res = subprocess.run(
            ["node", str(CLI_PATH), "--print-sources"],
            **_subprocess_kwargs(),
        )
        if res.returncode == 0 and res.stdout.strip():
            parsed = json.loads(res.stdout)
            if isinstance(parsed, list) and parsed:
                return parsed
    except Exception as e:
        log(f"⚠️ 無法從 cli.ts 讀取來源清單，改用預設清單: {e}")
    return list(FALLBACK_SOURCES)


def fetch_html_with_selenium(url: str) -> str | None:
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )

    service = Service()
    if sys.platform == "win32":
        service.creation_flags = subprocess.CREATE_NO_WINDOW

    driver = None
    try:
        driver = webdriver.Chrome(options=chrome_options, service=service)
        log(f"🌐 正在使用無頭瀏覽器訪問: {url}")
        driver.get(url)
        time.sleep(5)
        html_content = driver.page_source
        if "<tbody" not in html_content.lower():
            log(f"⚠️ {url} 未偵測到優惠碼表格（可能遭 Cloudflare 阻擋），略過此來源。")
            return None
        log(f"✨ 已擷取頁面 HTML ({len(html_content)} bytes)")
        return html_content
    except Exception as e:
        log(f"⚠️ Selenium 抓取失敗 ({url}): {e}")
        return None
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass


def update_coupons_json(once_per_day: bool = False, wait_net: bool = False, git_push: bool = False) -> bool:
    today_str = datetime.now().strftime("%Y-%m-%d")

    if once_per_day and STATE_FILE.exists():
        last_date = STATE_FILE.read_text(encoding="utf-8-sig").strip()
        if last_date == today_str:
            log(f"⏭️ 今日 ({today_str}) 已自動執行過優惠碼更新，略過本次執行。")
            return False

    if wait_net:
        log("🌐 正在確認網路連線...")
        if not wait_for_network(timeout_sec=90):
            log("⚠️ 等待網路連線逾時，取消本次更新。")
            return False

    if git_push:
        try:
            pull_res = subprocess.run(
                ["git", "pull", "--rebase", "origin", "main"],
                **_subprocess_kwargs(),
            )
            if pull_res.returncode == 0:
                log("🔄 預先同步遠端最新代碼庫成功。")
            else:
                log(f"⚠️ 預先 Git pull 失敗: {pull_res.stderr.strip()}")
        except Exception as e:
            log(f"⚠️ 預先 Git pull 例外: {e}")

    sources = load_scraper_sources()
    fetched_sources: list[dict[str, str]] = []
    for src in sources:
        html = fetch_html_with_selenium(src["url"])
        if html:
            fetched_sources.append(
                {
                    "platform": src["platform"],
                    "url": src["url"],
                    "html": html,
                }
            )

    if not fetched_sources:
        log("⚠️ 本次未成功取得任何來源表格，仍交由 pipeline.ts 進行過期與淘汰清理並保留現有有效資料。")

    cli_res = subprocess.run(
        ["node", str(CLI_PATH), "--sources-stdin"],
        input=json.dumps(fetched_sources, ensure_ascii=False),
        **_subprocess_kwargs(),
    )
    if cli_res.returncode != 0:
        log(f"❌ pipeline.ts 執行失敗: {cli_res.stderr.strip()}")
        return False

    if cli_res.stdout.strip():
        log(f"✅ {cli_res.stdout.strip()}")

    STATE_FILE.write_text(today_str, encoding="utf-8")

    if git_push:
        try:
            run_kwargs = _subprocess_kwargs()
            diff_res = subprocess.run(["git", "status", "--porcelain", "data/coupons.json"], **run_kwargs)
            if diff_res.stdout.strip():
                subprocess.run(["git", "add", "data/coupons.json"], **run_kwargs, check=True)
                subprocess.run(
                    ["git", "commit", "-m", f"chore(coupons): daily auto-update ({today_str})"],
                    **run_kwargs,
                    check=True,
                )
                subprocess.run(["git", "pull", "--rebase", "origin", "main", "-X", "theirs"], **run_kwargs)
                push_res = subprocess.run(["git", "push", "origin", "HEAD:main"], **run_kwargs)
                if push_res.returncode == 0:
                    log("🚀 已自動提交並推送最新 coupons.json 至 GitHub。")
                else:
                    log(f"⚠️ Git push 失敗: {push_res.stderr.strip()}")
            else:
                log("ℹ️ coupons.json 內容無變動，無需推送 Git。")
        except Exception as e:
            log(f"⚠️ Git 自動同步發生例外: {e}")

    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch CallingTaiwan coupons with Selenium and update data/coupons.json via cli.ts")
    parser.add_argument("--once-per-day", action="store_true", help="Only run once per calendar day")
    parser.add_argument("--wait-network", action="store_true", help="Wait up to 90s for network before scraping")
    parser.add_argument("--git-push", action="store_true", help="Auto commit and push data/coupons.json if changed")
    args = parser.parse_args()

    update_coupons_json(
        once_per_day=args.once_per_day,
        wait_net=args.wait_network,
        git_push=args.git_push,
    )
