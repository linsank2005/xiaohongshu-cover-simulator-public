import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "小红书封面 AI 模拟点击率",
  description: "单图封面 AI 模拟点击率测试工具"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
