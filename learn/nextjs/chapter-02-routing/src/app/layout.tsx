/**
 * 根布局 (Root Layout) —— 每个 Next.js (App Router) 项目【必需】的文件。
 *
 * 约定：src/app/layout.tsx 是整个应用的根布局，必须存在，
 * 而且必须亲自渲染 <html> 和 <body>。它会包裹所有页面（children）。
 * 这是一个服务端组件（默认即是）。
 *
 * 重要行为：当用户在「概览（/）」和「关于（/about）」两个子页面之间切换时，
 * 本根布局不会卸载或重新渲染——它的状态会被完整保留。
 * 只有 <main> 里的 children 部分（即当前页面）会被替换。
 */
import type { Metadata } from "next";
import Link from "next/link";
// 引入全局样式：只能在 layout / page 这类文件里 import 全局 CSS。
import "./globals.css";

// Metadata API：导出 metadata 对象，Next 会据此生成 <title>、<meta> 等。
export const metadata: Metadata = {
  title: "第 02 章 · 路由基础：页面、布局与导航",
  description: "文件即路由、page/layout、Link 客户端导航",
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
        {/* ── 顶部栏：整个应用共享，切换任何页面时都不会重新渲染 ── */}
        <header className="topbar">
          <span className="brand">第 02 章 · 路由基础：页面、布局与导航</span>
          <span className="brand-sub">Next.js App Router 教程</span>
        </header>

        {/*
         * ── 子导航：来自根布局，所有页面共享 ──────────────────────
         * 使用 next/link 的 <Link> 组件，实现无整页刷新的客户端导航。
         * 切换「概览」和「关于」子页面时，此导航栏不会消失或闪烁，
         * 因为它在根布局里——根布局在整个应用生命周期内保持挂载。
         */}
        <nav className="nav-no" style={{ display: "flex", gap: "12px", padding: "10px 24px", borderBottom: "1px solid #232a36" }}>
          {/* 概览页：对应 src/app/page.tsx，URL 为根路径 / */}
          <Link
            href="/"
            style={{
              display: "inline-block",
              padding: "5px 14px",
              borderRadius: "6px",
              background: "rgba(110,168,254,0.12)",
              color: "#6ea8fe",
              fontSize: "14px",
            }}
          >
            📄 概览
          </Link>

          {/* 关于页：对应 src/app/about/page.tsx，URL 为 /about */}
          <Link
            href="/about"
            style={{
              display: "inline-block",
              padding: "5px 14px",
              borderRadius: "6px",
              background: "rgba(110,168,254,0.12)",
              color: "#6ea8fe",
              fontSize: "14px",
            }}
          >
            ℹ️ 关于
          </Link>
        </nav>

        {/* children 是当前路由匹配到的 page 组件，切换页面时只有这里变化 */}
        <main className="content">{children}</main>
      </body>
    </html>
  );
}
