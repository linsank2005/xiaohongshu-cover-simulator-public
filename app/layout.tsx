import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "小红书封面 AI 对比测试",
  description: "本机运行的双封面模拟对比工具，支持模型设置、本地记录和文件导出"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
