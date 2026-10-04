"""端到端测试：真浏览器打开网页，连本地的假 GitHub（tests/fake_github.py），把主要功能走一遍。

    pip install playwright openpyxl && python -m playwright install chromium
    python tests/test_app.py            # 全部
    python tests/test_app.py 借出 出差    # 只跑名字里含这些字的步骤（前面的「连接」总会跑）

天气（Open-Meteo）和 DeepSeek 用假数据代替，不联网、不花钱。失败时截图在 tests/artifacts/。
"""

import functools
import json
import os
import struct
import subprocess
import sys
import threading
import traceback
import zlib
from datetime import date, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from fake_github import FakeRepo, serve  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "tests" / "artifacts"
APP_PORT, API_PORT = 8765, 8766
URL = f"http://127.0.0.1:{APP_PORT}/"
API = f"http://127.0.0.1:{API_PORT}"
REPO = "test/inventory-data"
D = lambda n: (date.today() + timedelta(days=n)).isoformat()  # noqa: E731


# ---------- 测试数据 ----------

def seed():
    L = lambda i, name, parent=None: {"id": i, "name": name, "parent": parent, "assetId": None}  # noqa: E731
    tags = ["电子产品", "衣服", "运动服", "鞋", "包", "洗漱护肤", "清洁用品", "床上用品", "文具", "书籍资料", "证件文件",
            "钥匙", "水杯餐具", "收藏纪念", "旅行用品", "搬家用品", "收纳容器", "日用杂物", "零食食品", "药品急救", "运动器材"]
    locations = [L("Lmain", "主屋 Main Room"), L("Lward", "当季衣柜 Current Season Wardrobe", "Lmain"),
                 L("Lsnack", "零食食品柜 Snacks & Food Storage", "Lmain"), L("Ldesk", "书桌 Desk", "Lmain"),
                 L("Ldrawer", "书桌抽屉 Desk Drawer", "Ldesk"), L("Lbulk", "囤货柜 Bulk Items Backstock", "Lmain"),
                 L("Lshoe", "鞋柜 Shoe Cabinet", "Lmain"), L("Lstore", "储物间 Storage Room")]

    def I(i, name, tag, loc, asset=None, **kw):  # noqa: E743
        return {"id": i, "name": name, "assetId": asset, "location": loc, "tags": [tag], "quantity": kw.pop("quantity", 1),
                "description": "", "fields": kw.pop("fields", {}), "photos": [], "receipts": [], "notes": "", "archived": False,
                "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z", **kw}

    items = [
        I("iw1", "黑色羽绒服", "衣服", "Lward", "110-001", fields={"季节": "冬", "颜色": "黑色", "部位": "外套", "厚薄": "厚"}, label="none"),
        I("iw2", "白色T恤", "衣服", "Lward", "110-002", fields={"季节": "夏", "颜色": "白色", "部位": "上衣", "厚薄": "薄"}, label="none"),
        I("iw3", "灰色卫衣", "衣服", "Lward", "110-003", fields={"季节": "春秋", "颜色": "灰色", "部位": "上衣", "厚薄": "适中"}, label="none"),
        I("ish", "白色运动鞋", "鞋", "Lshoe", "130-001", label="none"),
        I("iid", "身份证", "证件文件", "Ldrawer", "200-001", labelPrinted=False),
        I("ich", "手机充电器", "电子产品", "Ldrawer", "100-001", labelPrinted=False),
        I("itb", "牙刷", "洗漱护肤", "Lstore", "150-001", labelPrinted=False),
        I("imed", "布洛芬片", "药品急救", "Lbulk", "290-001", quantity=2, fields={"保质期": "2027-11-20"}, labelPrinted=False),
        I("ibook", "线性代数（第六版）", "书籍资料", "Ldrawer", "190-001", labelPrinted=False),
        I("isock", "黑袜子", "衣服", "Lward", "110-005", quantity=6, fields={"部位": "袜子"}, label="none",
          laundry={"state": "washing", "since": D(-1), "autoReturn": D(0)}),
        I("isheet", "灰色床单", "床上用品", "Lstore", "170-001", label="none", lastWashed=D(-20)),
        I("icold1", "999感冒灵颗粒", "药品急救", "Lbulk", "290-002", label="none"),
        I("icold2", "感康（复方氨酚烷胺片）", "药品急救", "Lbulk", "290-003", label="none"),
    ]
    locations.append(L("Lsummer", "夏季衣物与运动服柜 Summer Clothes & Sportswear Storage", "Lmain"))
    data = {"version": 1, "tags": tags, "locations": locations, "items": items, "prefs": {"homeCity": "济南"},
            "fieldPresets": {"衣服": ["季节", "颜色", "尺码"], "零食食品": ["保质期"], "药品急救": ["保质期", "规格", "剩余"]}}
    return {"inventory.json": json.dumps(data, ensure_ascii=False).encode()}


def png(path, rgb=(200, 80, 60)):
    w = h = 64
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))  # noqa: E731
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return path


# ---------- 运行框架 ----------

STEPS = []


def step(name):
    def wrap(fn):
        STEPS.append((name, fn))
        return fn
    return wrap


class Ctx:
    def __init__(self, page, repo):
        self.page, self.repo = page, repo
        self.prompt = ""

    def data(self):
        return json.loads(self.repo.read("inventory.json"))

    def item(self, name):
        return next(i for i in self.data()["items"] if i["name"] == name)

    def go(self, hash_):
        # 地址没变时浏览器不会重新渲染（比如连着两次进「新建」），这时强制刷新
        same = self.page.url == URL + hash_
        self.page.goto(URL + hash_)
        if same:
            self.page.reload()

    def wait_item(self, name):
        self.page.wait_for_function("location.hash.startsWith('#/item/') && !location.hash.endsWith('/edit')", timeout=20000)
        expect(self.page.locator(".item-title")).to_contain_text(name)

    def new_item(self, name, tag, loc_label, **opts):
        p = self.page
        self.go("#/new")
        p.get_by_label("名称").fill(name)
        p.get_by_label("位置").select_option(label=loc_label)
        p.get_by_role("button", name=tag, exact=True).click()
        if opts.get("photo"):
            p.locator("section").first.locator("input[type=file]").set_input_files(str(opts["photo"]))
        p.get_by_role("button", name="保存", exact=True).click()
        self.wait_item(name)
        return self.item(name)


# ---------- 测试步骤 ----------

@step("连接：设置令牌后进入首页，旧数据自动转换")
def _(c):
    p = c.page
    c.go("#/settings")
    p.evaluate(f"() => {{ localStorage.clear(); localStorage.setItem('inventory-api-base', '{API}'); }}")
    p.reload()
    p.get_by_label("数据仓库").fill(REPO)
    p.get_by_role("textbox", name="令牌", exact=True).fill("test-token")
    p.get_by_label("令牌到期日").fill(D(5))
    p.get_by_role("button", name="保存并连接").click()
    expect(p.get_by_role("heading", name="今天")).to_be_visible()
    expect(p.get_by_text("GitHub 令牌还有")).to_be_visible()
    c.go("#/items")
    expect(p.get_by_text("13 件")).to_be_visible()
    expect(p.locator(".tile", has_text="布洛芬片").locator(".asset")).to_have_text("290-0001")
    p.get_by_role("button", name="列表").click()
    expect(p.locator(".row", has_text="布洛芬片")).to_be_visible()
    p.get_by_role("button", name="按位置").click()
    expect(p.locator(".row.place", has_text="囤货柜 Bulk Items Backstock")).to_be_visible()
    p.get_by_role("button", name="按类别").click()


@step("新建：按类别自动编号（4 位）、贴标签开关、照片、表单不被后台刷新清空")
def _(c):
    p = c.page
    c.go("#/new")
    expect(p.get_by_text("选好标签后会按类别自动编号")).to_be_visible()
    p.get_by_role("button", name="电子产品", exact=True).click()
    expect(p.get_by_role("textbox", name="编号")).to_have_value("100-0002")
    expect(p.locator(".switch-row input").first).to_be_checked()
    p.get_by_label("名称").fill("降噪耳机")
    p.get_by_label("位置").select_option(label="　　书桌抽屉 Desk Drawer")
    p.locator("section").first.locator("input[type=file]").set_input_files(str(png(ART / "p.png")))
    d = c.data(); d["tags"].append("外部标签"); c.repo.external_write("inventory.json", json.dumps(d, ensure_ascii=False).encode())
    p.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    p.wait_for_timeout(1500)
    expect(p.get_by_label("名称")).to_have_value("降噪耳机")
    expect(p.locator(".photo-cell")).to_have_count(1)
    p.get_by_role("button", name="保存", exact=True).click()
    c.wait_item("降噪耳机")
    it = c.item("降噪耳机")
    assert it["assetId"] == "100-0002" and it["label"] == "pending" and len(it["photos"]) == 1, it
    assert c.repo.read(it["photos"][0]["thumb"]), "缩略图没上传"
    assert "外部标签" in c.data()["tags"], "覆盖了别处的修改"
    c.go("#/new")
    p.get_by_role("button", name="衣服", exact=True).click()
    expect(p.get_by_role("textbox", name="编号")).to_have_value("110-0006")
    expect(p.locator(".switch-row input").first).not_to_be_checked()
    # 只能选一个类别：再点别的就换成别的
    p.get_by_role("button", name="文具", exact=True).click()
    expect(p.locator(".chips .chip.on")).to_have_count(1)
    expect(p.locator(".chips .chip.on")).to_have_text("文具")
    expect(p.get_by_role("textbox", name="编号")).to_have_value("180-0001")


@step("别的设备抢先用了推荐的编号：保存时自动顺延")
def _(c):
    p = c.page
    c.go("#/new")
    p.get_by_label("名称").fill("充电宝")
    p.get_by_label("位置").select_option(label="　　书桌抽屉 Desk Drawer")
    p.get_by_role("button", name="电子产品", exact=True).click()
    expect(p.get_by_role("textbox", name="编号")).to_have_value("100-0003")
    d = c.data()
    d["items"].append({**c.item("降噪耳机"), "id": "iext", "name": "外部物品", "assetId": "100-0003", "photos": []})
    c.repo.external_write("inventory.json", json.dumps(d, ensure_ascii=False).encode())
    p.get_by_role("button", name="保存", exact=True).click()
    c.wait_item("充电宝")
    assert c.item("充电宝")["assetId"] == "100-0004"


@step("标签：导出 Excel、标记已打印、重新打印")
def _(c):
    import openpyxl
    p = c.page
    c.go("#/labels")
    d = c.data()
    n = sum(1 for x in d["items"] + d["locations"] if x.get("assetId") and x.get("label") == "pending" and not x.get("archived"))
    expect(p.get_by_role("button", name=f"待打印（{n}）")).to_be_visible()
    with p.expect_download() as dl:
        p.get_by_role("button", name="下载 Excel").click()
    path = ART / "labels.xlsx"
    dl.value.save_as(path)
    rows = [[x.value for x in r] for r in openpyxl.load_workbook(path).active.iter_rows()]
    assert rows[0] == ["编号", "名称", "二维码"] and len(rows) == n + 1, rows
    p.get_by_role("button", name="标记为已打印").click()
    expect(p.get_by_role("button", name=f"已打印（{n}）")).to_be_visible()
    c.go(f"#/item/{c.item('身份证')['id']}")
    p.get_by_role("button", name="重新打印").click()
    expect(p.locator(".row-meta .label-state").first).to_have_text("待打印")


@step("消耗品：用掉一个、用完了、补货（编号不变）")
def _(c):
    p = c.page
    med = c.item("布洛芬片")
    c.go(f"#/item/{med['id']}")
    p.get_by_role("button", name="用掉一个").click()
    expect(p.get_by_role("button", name="用掉一个")).to_have_count(0)
    p.get_by_role("button", name="用完了").click()
    expect(p.get_by_text("已用完，等补货")).to_be_visible()
    c.go("#/")
    expect(p.locator(".cell", has_text="1 件用完了")).to_be_visible()
    c.go("#/restock")
    p.get_by_role("button", name="补货").click()
    p.locator(".sheet input[type=number]").fill("3")
    p.locator(".sheet input[placeholder^='例如']").fill("2028-06")
    p.locator(".sheet").get_by_role("button", name="补货").click()
    expect(p.get_by_text("没有用完待补的东西")).to_be_visible()
    m = c.item("布洛芬片")
    assert m["quantity"] == 3 and m["fields"]["保质期"] == "2028-06" and m["assetId"] == "290-0001", m


@step("归档点选原因；删除后编号不复用")
def _(c):
    p = c.page
    c.go(f"#/item/{c.item('白色T恤')['id']}")
    p.get_by_role("button", name="归档").click()
    p.locator(".sheet").get_by_role("button", name="送人").click()
    p.locator(".sheet").get_by_role("button", name="归档").click()
    expect(p.get_by_text("已归档：送人")).to_be_visible()
    it = c.new_item("测试剪刀", "日用杂物", "　书桌 Desk")
    p.get_by_role("button", name="删除").click()
    p.wait_for_function("location.hash === '#/'")
    it2 = c.new_item("测试剪刀2", "日用杂物", "　书桌 Desk")
    assert (it["assetId"], it2["assetId"]) == ("270-0001", "270-0002"), (it["assetId"], it2["assetId"])


@step("借阅：借一本书、快到期提醒、续借、归还后归档")
def _(c):
    p = c.page
    c.go("#/borrow")
    p.get_by_role("button", name="借一本书").click()
    sh = p.locator(".sheet")
    sh.get_by_label("书名").fill("深度学习")
    sh.get_by_label("从哪借的").fill("学校图书馆")
    sh.get_by_label("借阅日期").fill(D(-28))
    sh.get_by_label("应还日期").fill(D(2))
    sh.get_by_role("button", name="记下").click()
    expect(p.locator(".row", has_text="深度学习")).to_contain_text("剩 2 天")
    book = c.item("深度学习")
    assert book["borrow"]["from"] == "学校图书馆" and book["tags"] == ["书籍资料"] and book["label"] == "none", book
    c.go("#/")
    expect(p.locator(".cell", has_text="1 本书要还了")).to_be_visible()
    c.go(f"#/item/{book['id']}")
    p.get_by_role("button", name="续借").click()
    p.locator(".sheet").get_by_label("新的应还日期").fill(D(30))
    p.locator(".sheet").get_by_role("button", name="续借").click()
    expect(p.get_by_text("还剩 30 天")).to_be_visible()
    p.get_by_role("button", name="已归还").click()
    expect(p.get_by_text("已归档：已归还")).to_be_visible()
    b = c.item("深度学习")
    assert b["archived"] and b["borrow"]["renewals"] == 1, b
    c.go("#/borrow")
    expect(p.locator(".section-title", has_text="已归还")).to_be_visible()


@step("装箱：新建箱子、装进去、全部放回原处")
def _(c):
    p = c.page
    c.go("#/boxes")
    p.get_by_role("button", name="新建箱子").click()
    p.locator(".sheet").get_by_role("button", name="新建").click()
    expect(p.get_by_role("heading", name="箱子 1")).to_be_visible()
    box = next(l for l in c.data()["locations"] if l.get("box") == "move")
    assert box["assetId"].startswith("010-") and box["label"] == "pending", box
    charger = c.item("手机充电器")
    c.go(f"#/item/{charger['id']}/edit")
    p.get_by_label("位置").select_option(label="箱子 1")
    p.get_by_role("button", name="保存", exact=True).click()
    c.wait_item("手机充电器")
    expect(p.get_by_text("原来在 主屋 Main Room / 书桌 Desk / 书桌抽屉 Desk Drawer")).to_be_visible()
    c.go(f"#/place/{box['id']}")
    p.get_by_role("button", name="全部放回原处（1）").click()
    expect(p.get_by_text("0 件")).to_be_visible()
    it = c.item("手机充电器")
    assert it["location"] == "Ldrawer" and "homeLocation" not in it, it


@step("出差：天气 + DeepSeek 推荐和穿搭、装进行李箱、回来放回原处")
def _(c):
    p = c.page
    # 旧版存在本机的密钥：打开网页时自动搬进数据仓库的 config/ai.json
    p.evaluate("() => localStorage.setItem('inventory-deepseek', JSON.stringify({ key: 'sk-test', model: 'deepseek-chat' }))")
    c.go("#/")
    p.reload()
    expect(p.locator(".toast", has_text="DeepSeek 密钥存到数据仓库")).to_be_visible()
    assert json.loads(c.repo.read("config/ai.json"))["deepseek"]["key"] == "sk-test"
    assert p.evaluate("() => localStorage.getItem('inventory-deepseek')") is None
    c.go("#/settings")
    expect(p.get_by_text("已连接 DeepSeek")).to_be_visible()
    expect(p.get_by_role("textbox", name="API 密钥")).to_be_hidden()   # 已连接时收起
    assert "sk-test" not in c.repo.read("inventory.json").decode()
    c.go("#/trips")
    p.get_by_role("button", name="新行程").click()
    p.get_by_label("目的地").fill("上海")
    p.get_by_label("出发").fill(D(2))
    p.get_by_label("返回").fill(D(4))
    p.get_by_role("button", name="见客户").click()
    p.get_by_role("button", name="生成推荐").click()
    expect(p.get_by_text("由 DeepSeek 推荐和搭配")).to_be_visible(timeout=20000)
    expect(p.get_by_text("每天穿搭")).to_be_visible()
    expect(p.get_by_text("转换插头")).to_be_visible()
    expect(p.locator(".check-row", has_text="不存在的东西")).to_have_count(0)   # AI 编的 id 被过滤
    p.screenshot(path=ART / "trip.png", full_page=True)
    p.get_by_role("button", name="装进行李箱").click()
    expect(p.get_by_role("button", name="回来了，全部放回原处")).to_be_visible()
    d = c.data()
    trip = d["trips"][0]
    assert trip["status"] == "packed" and sorted(trip["checked"]) == ["iid", "iw1", "iw3"], trip
    assert all(next(i for i in d["items"] if i["id"] == x)["location"] == trip["boxId"] for x in trip["checked"])
    c.go("#/")
    expect(p.locator(".cell", has_text="行李箱里还有东西")).to_contain_text("上海")
    c.go(f"#/trip/{trip['id']}")
    p.get_by_role("button", name="回来了，全部放回原处").click()
    expect(p.get_by_text("已结束").or_(p.get_by_role("button", name="用同样的条件再推荐一次"))).to_be_visible()
    d = c.data()
    assert next(i for i in d["items"] if i["id"] == "iw1")["location"] == "Lward"
    assert not any(l["id"] == trip["boxId"] for l in d["locations"]), "空行李箱没删掉"


@step("出差：没有 DeepSeek 时用规则推荐")
def _(c):
    p = c.page
    c.go("#/settings")
    p.get_by_text("更换或删除密钥").click()
    p.get_by_role("textbox", name="API 密钥").fill("")
    p.get_by_role("button", name="测试并保存到数据仓库").click()
    expect(p.get_by_text("还没有填")).to_be_visible()
    assert "deepseek" not in json.loads(c.repo.read("config/ai.json"))
    c.go("#/trips")
    p.get_by_role("button", name="新行程").click()
    p.get_by_label("目的地").fill("哈尔滨")
    p.get_by_label("出发").fill(D(1))
    p.get_by_label("返回").fill(D(3))
    p.get_by_role("button", name="生成推荐").click()
    expect(p.get_by_text("规则推荐")).to_be_visible(timeout=20000)
    for name in ["黑色羽绒服", "身份证", "手机充电器", "布洛芬片"]:
        expect(p.locator(".check-row", has_text=name)).to_be_visible()
    # 两种感冒药只带一种
    expect(p.locator(".check-row", has_text="感冒灵").or_(p.locator(".check-row", has_text="感康"))).to_have_count(1)
    expect(p.locator(".check-row", has_text="白色T恤")).to_have_count(0)   # 已归档，且是夏装


@step("今天穿什么：首页自动搭配、换一套、就穿这套记下穿着")
def _(c):
    p = c.page
    p.evaluate("() => localStorage.setItem('inventory-deepseek', JSON.stringify({ key: 'sk-test' }))")
    c.go("#/")
    p.reload()
    card = p.locator(".outfit-card")
    # 首页第一次打开时（还没有密钥）已经按规则生成过今天的搭配；有了 DeepSeek 后重新推荐
    expect(card.locator("h2")).to_be_visible(timeout=20000)
    c.go("#/outfit")
    p.get_by_role("button", name="宅宿舍").click()
    p.get_by_role("button", name="见客户").click()
    p.get_by_role("button", name="按新的安排重新推荐").click()
    expect(p.get_by_text("由 DeepSeek 搭配")).to_be_visible(timeout=20000)
    assert "见客户" in c.data()["outfit"]["schedule"]
    c.go("#/")
    expect(card.locator("h2")).to_have_text("灰卫衣配黑羽绒", timeout=20000)
    p.get_by_role("button", name="换一套（1/2）").click()
    expect(card.locator("h2")).to_have_text("暖和的一套")
    p.get_by_role("button", name="换一套（2/2）").click()
    p.get_by_role("button", name="就穿这套").click()
    expect(card.locator("h2")).to_contain_text("今天穿")
    d = c.data()
    assert d["outfit"]["chosen"] == 0 and d["outfit"]["source"] == "DeepSeek", d["outfit"]
    worn = {i["id"] for i in d["items"] if i.get("worn")}
    assert worn == {"iw3", "iw1", "ish"}, worn
    c.go("#/wear")
    expect(p.locator(".garment", has_text="灰色卫衣").first).to_be_visible()
    c.go("#/outfit")
    expect(p.get_by_text("今天穿的")).to_be_visible()


@step("问一问：回答带物品卡片；要修改的先确认再执行")
def _(c):
    p = c.page
    c.go("#/")
    p.locator(".ask-field").click()
    p.get_by_role("button", name="我的充电宝在哪？").click()
    expect(p.locator(".msg.ai").first).to_contain_text("在书桌抽屉")
    expect(p.locator(".msg.ai .row", has_text="手机充电器")).to_be_visible()
    p.locator(".chat-input textarea").fill("牙刷用完了")
    p.locator(".chat-input button").click()
    expect(p.get_by_text("要这样改吗？")).to_be_visible()
    assert c.item("牙刷")["quantity"] == 1, "没确认就改了"
    p.get_by_role("button", name="确认").click()
    expect(p.get_by_text("✓ 已完成 1 项修改")).to_be_visible()
    assert c.item("牙刷")["quantity"] == 0


@step("洗衣篮：今天穿的要洗吗、分批、开洗、收好了；贴身衣物自动收回；床单定期洗")
def _(c):
    p = c.page
    c.go("#/wardrobe")
    p.get_by_text("洗衣篮").click()
    card = p.locator(".card", has_text="要洗吗")
    expect(card.locator(".check-row", has_text="灰色卫衣").locator("input")).to_be_checked()      # 上衣穿 1 次就洗
    expect(card.locator(".check-row", has_text="黑色羽绒服").locator("input")).not_to_be_checked()  # 外套 5 次才洗
    expect(card.locator(".check-row", has_text="运动鞋")).to_have_count(0)                         # 鞋不进洗衣篮
    card.get_by_role("button", name="放进洗衣篮").click()
    expect(p.get_by_text("要洗吗")).to_have_count(0)
    d = c.data()
    assert d["prefs"]["laundryAsked"] and next(i for i in d["items"] if i["id"] == "iw3")["laundry"]["state"] == "dirty"
    sock = next(i for i in d["items"] if i["id"] == "isock")
    assert "laundry" not in sock, f"贴身衣物没自动收回：{sock}"
    expect(p.locator(".group-title", has_text="深色")).to_be_visible()                               # 灰色归深色一批
    expect(p.locator(".section-title", has_text="床上用品该洗了")).to_be_visible()
    c.go(f"#/item/{c.item('黑色羽绒服')['id']}")
    p.get_by_role("button", name="放进洗衣篮").click()
    expect(p.get_by_text("在洗衣篮里")).to_be_visible()
    c.go("#/laundry")
    expect(p.locator(".group-title", has_text="单独洗或送洗")).to_be_visible()                       # 羽绒服单独洗
    p.get_by_role("button", name="开洗勾选的").click()
    expect(p.locator(".section-title", has_text="在洗 / 在晾（2）")).to_be_visible()
    assert not any(i["id"] == "iw3" for i in __import__("json").loads(c.repo.read("inventory.json"))["items"] if not i.get("laundry")), "卫衣应该在洗"
    p.get_by_role("button", name="收好了").click()
    expect(p.locator(".section-title", has_text="在洗 / 在晾")).to_have_count(0)
    w = c.item("灰色卫衣")
    assert "laundry" not in w and w["wearsSinceWash"] == 0 and w["lastWashed"], w
    c.go("#/settings")
    expect(p.locator(".card", has_text="手机提醒")).to_be_visible()


@step("AI 补全：只填名称，推荐类别和字段")
def _(c):
    p = c.page
    p.evaluate("() => localStorage.setItem('inventory-deepseek', JSON.stringify({ key: 'sk-test' }))")
    c.go("#/new")
    p.reload()
    p.wait_for_function("!localStorage.getItem('inventory-deepseek')")   # 密钥已搬进数据仓库
    p.get_by_label("名称").fill("优衣库摇粒绒外套")
    p.get_by_role("button", name="AI 补全").click()
    expect(p.locator(".ai-suggest")).to_contain_text("部位：外套")
    p.locator(".ai-suggest").get_by_role("button", name="采用").click()
    expect(p.get_by_role("button", name="衣服", exact=True)).to_have_class("chip on")
    expect(p.locator(".field-row select").first).to_have_value("外套")
    expect(p.get_by_role("textbox", name="编号")).to_have_value("110-0006")


@step("换季整理：列出该收起来的，按勾选移动")
def _(c):
    p = c.page
    c.go("#/season")
    expect(p.locator(".section-title", has_text="收起来")).to_be_visible()
    before = {i["id"]: i["location"] for i in c.data()["items"]}
    p.get_by_role("button", name="按勾选整理").click()
    expect(p.get_by_text("当季衣柜里正好都是该穿的")).to_be_visible()
    after = {i["id"]: i["location"] for i in c.data()["items"]}
    assert after != before, "没有移动任何衣服"


@step("设置：常住城市存进数据")
def _(c):
    p = c.page
    c.go("#/settings")
    card = p.locator(".card", has_text="常住城市")
    card.locator("input").fill("北京")
    card.get_by_role("button", name="保存").click()
    expect(p.locator(".toast", has_text="已保存")).to_be_visible()
    assert c.data()["prefs"]["homeCity"] == "北京"


@step("导出全部物品 Excel")
def _(c):
    import openpyxl
    p = c.page
    c.go("#/me")
    with p.expect_download() as dl:
        p.get_by_role("button", name="导出全部物品（Excel）").click()
    path = ART / "all.xlsx"
    dl.value.save_as(path)
    rows = list(openpyxl.load_workbook(path).active.iter_rows(values_only=True))
    assert rows[0][:3] == ("编号", "名称", "类别") and len(rows) == len(c.data()["items"]) + 1


@step("批量录入脚本：自动编号接着网页的往后排")
def _(c):
    manifest = ART / "manifest.json"
    manifest.write_text(json.dumps({"location": "书桌抽屉", "items": [
        {"name": "数据线", "tags": ["电子产品"], "quantity": 2},
        {"name": "条纹衬衫", "tags": ["衣服"], "location": "当季衣柜", "fields": {"季节": "春秋"}},
        {"name": "薯片", "tags": ["零食食品"], "location": "零食食品柜"},
    ]}, ensure_ascii=False))
    env = {**os.environ, "GITHUB_API_URL": API, "GITHUB_TOKEN": "test-token", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
    out = subprocess.run([sys.executable, str(ROOT / "tools/import_items.py"), "--repo", REPO, str(manifest)],
                         capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stdout + out.stderr
    d = c.data()
    got = {i["name"]: (i["assetId"], i["label"], i["consumable"]) for i in d["items"] if i["name"] in ("数据线", "条纹衬衫", "薯片")}
    assert got == {"数据线": ("100-0005", "pending", False), "条纹衬衫": ("110-0006", "none", False),
                   "薯片": ("280-0001", "pending", True)}, got


# ---------- 假的天气和 DeepSeek ----------

def fake_externals(page):
    page.route("https://geocoding-api.open-meteo.com/**", lambda r: r.fulfill(json={
        "results": [{"name": "上海", "admin1": "上海", "latitude": 31.2, "longitude": 121.5}]}))
    page.route("https://api.open-meteo.com/**", lambda r: r.fulfill(json={
        "hourly": {"temperature_2m": [8] * 7 + [9, 10, 11, 13, 14, 16, 17, 16, 15, 14, 13, 12, 11, 10, 10, 9],
                   "precipitation_probability": [10] * 24, "wind_speed_10m": [8] * 24},
        "daily": {"time": [D(1), D(2), D(3), D(4)], "temperature_2m_min": [-5, 6, 7, 8], "temperature_2m_max": [3, 15, 16, 14],
                  "precipitation_probability_max": [10, 60, 20, 10], "weather_code": [71, 61, 3, 3]}}))
    trip = {"items": [{"id": "iw1", "qty": 1, "reason": "早晚冷"}, {"id": "iw3", "qty": 1, "reason": "白天穿"},
                      {"id": "iid", "qty": 1, "reason": "必带"}, {"id": "不存在的东西", "qty": 1, "reason": "AI 编的"}],
            "outfits": [{"day": D(2)[5:], "items": ["iw3", "iw1"], "note": "灰配黑"}],
            "missing": [{"name": "转换插头", "reason": "酒店插座"}], "tips": ["带伞"]}
    outfit = {"options": [{"title": "灰卫衣配黑羽绒", "items": ["iw3", "iw1", "ish", "不存在"], "why": "早上冷", "tips": ["中午可以脱外套"]},
                          {"title": "暖和的一套", "items": ["iw1", "ish"], "why": "更暖", "tips": []}]}
    autofill = {"category": "衣服", "fields": {"部位": "外套", "季节": "冬", "厚薄": "厚", "颜色": "灰"}, "consumable": False, "note": ""}

    def chat(user):
        if "充电宝" in user:
            return {"answer": "在书桌抽屉里。", "items": ["ich"], "actions": []}
        if "牙刷" in user:
            return {"answer": "要把牙刷标记为用完吗？", "items": ["itb"], "actions": [{"type": "use_up", "id": "itb"}]}
        return {"answer": "不知道", "items": [], "actions": []}

    def deepseek(route):
        if route.request.url.endswith("/models"):
            return route.fulfill(json={"data": [{"id": "deepseek-flash"}, {"id": "deepseek-v4-pro"}]})
        body = json.loads(route.request.post_data)
        system, user = body["messages"][0]["content"], body["messages"][-1]["content"]
        if "收拾行李" in system:
            ans = trip
        elif "搭配日常穿着" in system:
            ans = outfit
        elif "给宿舍里的物品建档" in system:
            ans = autofill
        else:
            ans = chat(user)
        route.fulfill(json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(ans, ensure_ascii=False)}}]})
    page.route("https://api.deepseek.com/**", deepseek)


def main():
    only = sys.argv[1:]
    ART.mkdir(exist_ok=True)
    repo = FakeRepo(seed())
    serve(repo, API_PORT)
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a: None
    app = ThreadingHTTPServer(("127.0.0.1", APP_PORT), handler)
    threading.Thread(target=app.serve_forever, daemon=True).start()

    failed, errors, ran = [], [], 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, accept_downloads=True)
        ctx.set_default_timeout(10000)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        c = Ctx(page, repo)
        page.on("dialog", lambda d: d.accept(c.prompt) if d.type == "prompt" else d.accept())
        fake_externals(page)
        for i, (name, fn) in enumerate(STEPS):
            if i and only and not any(k in name for k in only):
                continue
            ran += 1
            try:
                fn(c)
                print(f"  ✓ {name}")
            except Exception:
                failed.append(name)
                page.screenshot(path=ART / f"fail-{i:02d}.png", full_page=True)
                print(f"  ✗ {name}\n{traceback.format_exc()}")
                if i == 0:
                    break
        browser.close()
    if errors:
        print("页面报错：", *errors, sep="\n  ")
    print(f"\n{ran - len(failed)}/{ran} 通过" + ("" if ran == len(STEPS) else f"（共 {len(STEPS)} 项，没跑完）"))
    sys.exit(1 if failed or errors else 0)


if __name__ == "__main__":
    main()
