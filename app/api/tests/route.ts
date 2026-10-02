import { dataDirectory } from "@/lib/storage";
import { limitedRequest } from "@/lib/api-boundary";
import { validateUploadedImage } from "@/lib/upload-image";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ActiveTestError, createTest, getTestByRequestKey } from "@/lib/db";
import { isModelProvider, type ModelProvider } from "@/lib/model-options";
import { chooseRandomReferences, loadReferenceLibrary } from "@/lib/reference-library";
import { runSimulation } from "@/lib/simulation";
import { isTestMode, type TestMode } from "@/lib/types";
import { runtimeModelConfig } from "@/lib/model-settings";
import { assertOllamaReady } from "@/lib/ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedTypes = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);

export async function POST(request: Request) {
  const writtenPaths: string[] = [];
  let accepted = false;
  try {
    request = await limitedRequest(request, 21 * 1024 * 1024);
    const formData = await request.formData();
    const requestKey = formData.get("requestKey");
    if (typeof requestKey !== "string" || !/^[0-9a-f-]{36}$/i.test(requestKey)) return Response.json({ error: "缺少有效的请求 ID" }, { status: 400 });
    const existing = await getTestByRequestKey(requestKey);
    if (existing) return Response.json({ id: existing.id }, { status: 202 });
    const covers = formData.getAll("cover").filter((value): value is File => value instanceof File);
    const rawTitle = formData.get("title");
    const rawProvider = formData.get("provider");
    const rawTestMode = formData.get("testMode");
    if (covers.length !== 2) return Response.json({ error: "请上传 2 张候选封面图" }, { status: 400 });
    if (typeof rawTitle !== "string" || !rawTitle.trim()) return Response.json({ error: "请输入笔记标题" }, { status: 400 });

    let provider: ModelProvider = "ollama";
    if (rawProvider !== null) {
      if (!isModelProvider(rawProvider)) return Response.json({ error: "模型选择无效" }, { status: 400 });
      provider = rawProvider;
    }
    let testMode: TestMode = "grid";
    if (rawTestMode !== null) {
      if (!isTestMode(rawTestMode)) return Response.json({ error: "测试场景无效" }, { status: 400 });
      testMode = rawTestMode;
    }
    const modelConfig = runtimeModelConfig(provider, testMode);
    if (!modelConfig.apiKey) {
      return Response.json({ error: "尚未配置 API Key，请打开页面右上角的模型设置" }, { status: 400 });
    }
    for (const cover of covers) {
      if (!allowedTypes.has(cover.type)) return Response.json({ error: "仅支持 JPG、PNG、WEBP 图片" }, { status: 400 });
      if (cover.size > 10 * 1024 * 1024) return Response.json({ error: "图片不能超过 10MB" }, { status: 400 });
    }
    const title = rawTitle.trim();
    if (title.length > 80) return Response.json({ error: "标题不能超过 80 个字符" }, { status: 400 });
    if (provider === "ollama") await assertOllamaReady(modelConfig.baseUrl, modelConfig.model);

    const images = await Promise.all(covers.map(async cover => {
      const bytes = Buffer.from(await cover.arrayBuffer());
      const extension = await validateUploadedImage(bytes);
      return { bytes, extension };
    }));
    const id = randomUUID();
    const uploadDir = path.join(dataDirectory(), "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const randomSeed = randomUUID();
    const candidates = covers.map((cover, index) => {
      const key = String.fromCharCode(65 + index);
      return {
        key,
        label: "封面 " + key,
        path: path.join(uploadDir, id + "-" + key + "." + images[index].extension)
      };
    });
    for (const [index, cover] of covers.entries()) {
      writtenPaths.push(candidates[index].path);
      await fs.writeFile(candidates[index].path, images[index].bytes);
    }

    const referenceCount = testMode === "vertical" ? 9 : 3;
    const references = chooseRandomReferences(loadReferenceLibrary(referenceCount), referenceCount);
    const created = await createTest({
      requestKey,
      id,
      uploadedPath: candidates[0].path,
      candidates,
      title,
      referenceIds: references.map((reference) => reference.id),
      randomSeed,
      testMode
    });
    if (!created.created) return Response.json({ id: created.id }, { status: 202 });
    accepted = true;
    void runSimulation(id, candidates, references, title, provider, randomSeed, testMode, { modelConfig }).catch(error => {
      console.error("测试执行器异常", { id, message: error instanceof Error ? error.message : "未知错误" });
    });
    return Response.json({ id }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "测试创建失败" }, { status: error instanceof ActiveTestError ? 409 : 400 });
  } finally {
    if (!accepted) await Promise.all(writtenPaths.map(file => fs.rm(file, { force: true })));
  }
}
