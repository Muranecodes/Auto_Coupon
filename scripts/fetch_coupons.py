import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

CHECKOUT_ONLY_REGEX = re.compile(
    r"信用卡|刷卡|簽帳卡|金融卡|銀行|中國信託|中信|國泰世華|國泰|玉山|台新|富邦|永豐|聯邦|星展|滙豐|匯豐|兆豐|第一銀行|華南|合作金庫|彰銀|LINE\s*Pay\s*卡|CUBE\s*卡|結帳限定|結帳輸入|限定結帳|訂閱\s*pandapro",
    re.IGNORECASE,
)


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
        chrome_options.add_argument("--headless")
        # 禁用 GPU 加速，有时能避免一些奇怪的错误
        chrome_options.add_argument("--disable-gpu")
        # 确保在沙箱环境下运行
        chrome_options.add_argument("--no-sandbox")
        # 设定一个 User-Agent 来进一步伪装成普通浏览器
        chrome_options.add_argument(
            "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )

        try:
            # 启动 Chrome 浏览器
            driver = webdriver.Chrome(options=chrome_options)

            print(f"✅ 浏览器已启动，正在访问: {url}")

            # 访问目标 URL
            driver.get(url)

            # --- 关键步骤：等待页面完全加载 ---
            # 如果页面有大量 JavaScript 渲染，可能需要等待几秒
            time.sleep(5)
            print("⏳ 页面加载完成，等待 5 秒以确保 JS 执行完毕...")

            # 获取当前页面的完整 HTML 源码
            html_content = driver.page_source

            print("✨ 已获取页面源码。")

            # --- 将源码传递给 BeautifulSoup 进行解析 ---
            soup = BeautifulSoup(html_content, "html.parser")

            print("解析完成！以下是页面的标题：")
            # 示例：打印解析后的页面标题
            print(soup.title.text if soup.title else "未找到标题")

        except Exception as e:
            print(f"❌ 发生错误: {e}")

        finally:
            # 无论成功还是失败，都要关闭浏览器和驱动程序
            if "driver" in locals():
                driver.quit()
                print("🗑️ 浏览器已关闭。")

        tbody = soup.find("tbody")
        rows = tbody.find_all("tr")[1:]

        # 初始化結果清單
        result = []
        details = []

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
                            "expiresAt": parse_expiration_date(expire_text),
                            "category": classify_category(content),
                        }
                    )

        return details if return_details else result
    except Exception as e:
        print(f"抓取失敗: {e}")
        return []


def update_coupons_json():
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

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    merged: dict[str, dict] = {}

    for platform, url in sources:
        items = fetch_coupons(url, return_details=True)
        print(f"[{platform}] 共擷取 {len(items)} 組優惠碼: {[i['code'] for i in items]}")
        for item in items:
            key = f"{platform}:{item['code']}"
            merged[key] = {
                "code": item["code"],
                "platform": platform,
                "title": item["title"],
                "category": item["category"],
                "expiresAt": item["expiresAt"],
                "sourceUrl": url,
                "updatedAt": now_iso,
            }

    sorted_coupons = sorted(
        merged.values(),
        key=lambda x: (x["platform"], x["category"], x["code"]),
    )

    feed = {
        "updatedAt": now_iso,
        "coupons": sorted_coupons,
    }

    repo_root = Path(__file__).resolve().parent.parent
    data_path = repo_root / "data" / "coupons.json"
    data_path.parent.mkdir(parents=True, exist_ok=True)
    data_path.write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✅ 已更新 {data_path}（共 {len(sorted_coupons)} 筆優惠碼）")


if __name__ == "__main__":
    update_coupons_json()
