import argparse
import json
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / "data" / "coupons.json"
STATE_FILE = REPO_ROOT / ".last_scrape_date"
LOG_FILE = REPO_ROOT / "logs" / "daily_scrape.log"

CHECKOUT_ONLY_REGEX = re.compile(
    r"信用卡|刷卡|簽帳卡|金融卡|銀行|中國信託|中信|國泰世華|國泰|玉山|台新|富邦|永豐|聯邦|星展|滙豐|匯豐|兆豐|第一銀行|華南|合作金庫|彰銀|LINE\s*Pay\s*卡|CUBE\s*卡|結帳限定|結帳輸入|限定結帳|訂閱\s*pandapro",
    re.IGNORECASE,
)


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


def parse_expiration_date(text: str, reference_year: int = 2026) -> str | None:
    m_full = re.search(r"(20\d{2})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})", text)
    if m_full:
        return f"{m_full.group(1)}-{int(m_full.group(2)):02d}-{int(m_full.group(3)):02d}"
    m_short = re.search(r"(\d{1,2})\s*[\/\-月]\s*(\d{1,2})", text)
    if m_short:
        return f"{reference_year}-{int(m_short.group(1)):02d}-{int(m_short.group(2)):02d}"
    return None


def classify_category(content: str) -> str:
    if CHECKOUT_ONLY_REGEX.search(content):
        return "checkout_only"
    return "wallet"


def fetch_coupons(url, return_details=False):
    try:
        # --- 配置 Chrome Options (推荐使用无头模式) ---
        chrome_options = Options()
        # 运行在后台（不弹出浏览器窗口），更高效且适合服务器环境
        chrome_options.add_argument("--headless=new")
        # 禁用 GPU 加速，有时能避免一些奇怪的错误
        chrome_options.add_argument("--disable-gpu")
        # 确保在沙箱环境下运行
        chrome_options.add_argument("--no-sandbox")
        # 设定一个 User-Agent 来进一步伪装成普通浏览器
        chrome_options.add_argument(
            "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )

        service = Service()
        if sys.platform == "win32":
            # 隱藏 Windows 下 chromedriver.exe 的黑框視窗
            service.creation_flags = subprocess.CREATE_NO_WINDOW

        soup = None
        try:
            # 启动 Chrome 浏览器
            driver = webdriver.Chrome(options=chrome_options, service=service)

            log(f"✅ 浏览器已启动，正在访问: {url}")

            # 访问目标 URL
            driver.get(url)

            # --- 关键步骤：等待页面完全加载 ---
            # 如果页面有大量 JavaScript 渲染，可能需要等待几秒
            time.sleep(5)
            log("⏳ 页面加载完成，等待 5 秒以确保 JS 执行完毕...")

            # 获取当前页面的完整 HTML 源码
            html_content = driver.page_source

            log("✨ 已获取页面源码。")

            # --- 将源码传递给 BeautifulSoup 进行解析 ---
            soup = BeautifulSoup(html_content, "html.parser")

            log(f"解析完成！页面标题：{soup.title.text if soup.title else '未找到标题'}")

        except Exception as e:
            log(f"❌ 发生错误: {e}")

        finally:
            # 无论成功还是失败，都要关闭浏览器和驱动程序
            if "driver" in locals():
                driver.quit()
                log("🗑️ 浏览器已关闭。")

        if soup is None:
            return []

        tbody = soup.find("tbody")
        if tbody is None:
            return []
        rows = tbody.find_all("tr")[1:]

        # 初始化結果清單
        result = []
        details = []
        ref_year = datetime.now().year

        for row in rows:
            tds = row.find_all("td")
            if len(tds) < 3:
                continue
            # 獲取有效期限欄位 (若有)
            expire_text = tds[0].get_text(strip=True)
            # 獲取優惠內容
            content = tds[1].get_text(strip=True).replace("\xa0", " ")
            # 獲取優惠碼 (處理 <br> 多組優惠碼或括號備註)
            raw_lines = [
                line.split("(")[0].strip()
                for line in tds[2].get_text(separator="\n", strip=True).splitlines()
            ]

            for code in raw_lines:
                if not code:
                    continue
                # 篩選【】內不含 "首購" 的條件，並排除非優惠碼按鈕文字
                if (
                    "首購" not in content
                    and "前往訂餐" not in code
                    and "前往兌換" not in code
                ):
                    result.append(code)
                    details.append(
                        {
                            "code": code,
                            "title": content,
                            "expiresAt": parse_expiration_date(expire_text, ref_year),
                            "category": classify_category(content),
                        }
                    )

        return details if return_details else result
    except Exception as e:
        log(f"抓取失敗: {e}")
        return []


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

    sources = [
        (
            "foodpanda",
            "https://www.callingtaiwan.com.tw/foodpanda-coupon-code/#%E5%84%AA%E6%83%A0%E5%88%97%E8%A1%A8",
        ),
        (
            "ubereats",
            "https://www.callingtaiwan.com.tw/ubereats%E5%84%AA%E6%83%A0-%E6%9C%80%E6%96%B0%E9%A4%90%E5%BB%B3%E5%A4%96%E9%80%81%E9%A6%96%E8%B3%BC%E5%84%AA%E6%83%A0%E5%BA%8F%E8%99%9F-%E6%8A%98%E6%89%A3%E7%A2%BC-%E6%8E%A8%E8%96%A6%E7%A2%BC/",
        ),
    ]

    existing_by_key: dict[str, dict] = {}
    existing_updated_at: str | None = None
    if DATA_PATH.exists():
        try:
            existing_feed = json.loads(DATA_PATH.read_text(encoding="utf-8"))
            existing_updated_at = existing_feed.get("updatedAt")
            for item in existing_feed.get("coupons", []):
                existing_by_key[f"{item.get('platform')}:{item.get('code')}"] = item
        except Exception:
            pass

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    merged: dict[str, dict] = {}

    for platform, url in sources:
        items = fetch_coupons(url, return_details=True)
        log(f"[{platform}] 共擷取 {len(items)} 組優惠碼: {[i['code'] for i in items]}")
        for item in items:
            key = f"{platform}:{item['code']}"
            prev = existing_by_key.get(key)
            entry = {
                "code": item["code"],
                "platform": platform,
                "title": item["title"],
                "category": item["category"],
                "expiresAt": item["expiresAt"],
                "sourceUrl": url,
                "updatedAt": now_iso,
            }
            if prev and all(
                prev.get(k) == entry.get(k)
                for k in ("code", "platform", "title", "category", "expiresAt", "sourceUrl")
            ):
                entry["updatedAt"] = prev.get("updatedAt", now_iso)
            merged[key] = entry

    if not merged:
        log("⚠️ 未擷取到任何優惠碼，保留現有 coupons.json。")
        return False

    sorted_coupons = sorted(
        merged.values(),
        key=lambda x: (x["platform"], x["category"], x["code"]),
    )

    prev_list = [existing_by_key[k] for k in sorted(existing_by_key.keys())] if existing_by_key else []
    is_unchanged = (
        existing_updated_at is not None
        and len(sorted_coupons) == len(existing_by_key)
        and all(
            c.get("updatedAt") == existing_by_key.get(f"{c['platform']}:{c['code']}", {}).get("updatedAt")
            for c in sorted_coupons
        )
    )

    feed = {
        "updatedAt": existing_updated_at if is_unchanged else now_iso,
        "coupons": sorted_coupons,
    }

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    STATE_FILE.write_text(today_str, encoding="utf-8")
    log(f"✅ 已更新 {DATA_PATH}（共 {len(sorted_coupons)} 筆優惠碼）")

    if git_push:
        try:
            run_kwargs = {"cwd": str(REPO_ROOT), "capture_output": True, "text": True}
            if sys.platform == "win32":
                run_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
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
    parser = argparse.ArgumentParser(description="Fetch CallingTaiwan coupons and update data/coupons.json")
    parser.add_argument("--once-per-day", action="store_true", help="Only run once per calendar day")
    parser.add_argument("--wait-network", action="store_true", help="Wait up to 90s for network before scraping")
    parser.add_argument("--git-push", action="store_true", help="Auto commit and push data/coupons.json if changed")
    args = parser.parse_args()

    update_coupons_json(
        once_per_day=args.once_per_day,
        wait_net=args.wait_network,
        git_push=args.git_push,
    )
