/**
 * 根布局 (Root Layout) —— 每个 Next.js (App Router) 项目【必需】的文件。
 *
 * 约定：src/app/layout.tsx 是整个应用的根布局，必须存在，
 * 而且必须亲自渲染 <html> 和 <body>。它会包裹所有页面（children）。
 * 这是一个服务端组件（默认即是）。
 */
import type { Metadata } from "next";
// 引入全局样式：只能在 layout / page 这类文件里 import 全局 CSS。
import "./globals.css";

// Metadata API：导出 metadata 对象，Next 会据此生成 <title>、<meta> 等。
export const metadata: Metadata = {
  title: "第 07 章 · 加载、错误与 404 UI",
  description: "loading/error/not-found 特殊文件",
};

export default function RootLayout({
  // children 就是当前路由匹配到的页面内容，由 Next 自动注入。
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="topbar">
          <span className="brand">第 07 章 · 加载、错误与 404 UI</span>
          <span className="brand-sub">Next.js App Router 教程</span>
        </header>
        <main className="content">{children}</main>
      </body>
    </html>
  );
}
