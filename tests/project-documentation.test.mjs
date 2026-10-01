import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const documentPath = path.join(projectRoot, "docs", "project-overview-and-realism-roadmap.md");
const guidancePath = path.join(projectRoot, "docs", "development-guidance-and-validation-plan.md");
const openSourcePlanPath = path.join(projectRoot, "docs", "open-source-and-data-contribution-plan.md");
const readmePath = path.join(projectRoot, "README.md");

test("项目介绍文档包含当前实现边界和真实 CTR 优化主线", () => {
  const document = fs.readFileSync(documentPath, "utf8");
  assert.match(document, /当前已经实现的能力/);
  assert.match(document, /技术框架/);
  assert.match(document, /模拟信息流选择率/);
  assert.match(document, /两个候选版本/);
  assert.match(document, /配对比较/);
  assert.match(document, /不应被解释为“这篇笔记发布后的真实 CTR 百分比”/);
  assert.match(document, /真实标签闭环/);
  assert.match(document, /纵向信息流/);
  assert.match(document, /概率校准/);
  assert.match(document, /不能替代真实发布数据/);
  assert.match(document, /测试任务可取消/);
  assert.match(document, /取消后不再调度新的 Agent 请求/);
  assert.match(document, /状态为 `cancelled`/);
  assert.match(document, /校准基线/);
  assert.match(document, /GLM-5\.3-Flash/);
});

test("后续开发指引固定产品边界和真实验证口径", () => {
  const guidance = fs.readFileSync(guidancePath, "utf8");
  assert.match(guidance, /发布前双封面相对排序工具/);
  assert.match(guidance, /xiaohongshu-cover-pk/);
  assert.match(guidance, /赢家一致率/);
  assert.match(guidance, /测试任务可取消/);
  assert.match(guidance, /GLM-5\.3-Flash/);
  assert.match(guidance, /CSV\/JSON/);
  assert.match(guidance, /100 条有效样本/);
});

test("README documents copyable run and verification commands", () => {
  const readme = fs.readFileSync(readmePath, "utf8");
  assert.match(readme, /npm install/);
  assert.match(readme, /npm run dev/);
  assert.match(readme, /npm test/);
  assert.match(readme, /npm run typecheck/);
  assert.match(readme, /npm run build/);
  assert.match(readme, /npm run start/);
});

test("开源与数据贡献方案明确本地运行、授权和积分边界", () => {
  const plan = fs.readFileSync(openSourcePlanPath, "utf8");
  const readme = fs.readFileSync(readmePath, "utf8");
  assert.match(readme, /开源与真实数据贡献方案/);
  assert.match(plan, /本地开源核心/);
  assert.match(plan, /API Key 始终保存在用户本机/);
  assert.match(plan, /Level 1：匿名结构化结果/);
  assert.match(plan, /Level 2：结果加封面素材/);
  assert.match(plan, /积分只奖励有效贡献/);
  assert.match(plan, /一个测试 ID 只能提交一次结果/);
  assert.match(plan, /数据贡献协议/);
  assert.match(plan, /个人校准能力/);
});
