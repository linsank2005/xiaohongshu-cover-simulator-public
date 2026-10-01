# 100 张模拟参考封面 · 统一预览

这些图片是根据小红书原封面逐张作为参考，通过内置 imagegen 生成的模拟示例，并非真实发布的封面。

## 本轮结果

- 100 张原稿分别对应 `ref-001` 至 `ref-100`，每张初始生成只输入一张原稿作为参考。
- 沿用已确认的 5 张样图，新增生成 95 张；保留主要版式、主体安排和原稿画面比例，重新生成画面并改写文案。
- 原始图片、原笔记 ID、账号链接和采集信息未进入本仓库。生成图片内的资料卡及数字为模拟内容。
- PNG 保存在本目录，名称为 `sim-001.png` 至 `sim-100.png`。
- `manifest.json` 保存生成提示词、尺寸、SHA-256、逐张参考数量及复用／修订记录。角落残留水印通过 imagegen 编辑修订，修订参考为对应的模拟图。
- 当前状态：用户已确认全部 100 张，已接入运行时图库。`manifest.json` 标记为 `active`，逐张审阅状态为 `approved`，记录沿用的抽样权重。

## 打开预览

直接用浏览器打开本目录的 [index.html](index.html)，无需联网。可以按类别、内容类型筛选，搜索编号或标题，点击图片放大并翻页。

也可在仓库根目录运行：

```powershell
python -m http.server 4178 --bind 127.0.0.1 --directory previews/generated-reference-library
```

然后访问 `http://127.0.0.1:4178/`。按 `Ctrl+C` 停止服务。

## 核对与重建

```powershell
npm test
node scripts/reference-preview.mjs build
```

测试核对完整数量、唯一编号、图片解码、尺寸与哈希、原稿与样图的比例、5 张已确认样图的原样复用及预览清单一致性。比例允许 imagegen 输出像素尺寸的少量舍入误差。

运行时清单位于 `data/reference-covers.json`，图片位于 `public/reference-covers`；运行时图片与本目录批准版本逐张字节一致。旧项目原图仍保留。实测步骤见 [模拟图库实测](../../docs/manual-mock-cover-test.md)。
