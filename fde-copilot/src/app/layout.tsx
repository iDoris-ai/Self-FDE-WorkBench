import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FDE Copilot",
  description: "客户售前/持续测试的多模态对话 → loop-ready spec 生成器",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
