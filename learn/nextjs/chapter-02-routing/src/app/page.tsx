/**
 * 第 02 章 · 概览页 (Overview Page)
 *
 * 文件位置：src/app/page.tsx
 * 访问 URL ：/（根路径）
 *
 * App Router 约定
 * ─────────────────────────────────────────────────────────
 * • page.tsx   → 定义该路由段的「可访问页面」，URL 能打开它。
 * • layout.tsx → 定义该路由段的「共享外壳」，URL 不能直接打开它。
 *
 * 这是一个「服务端组件」（Server Component），默认如此，无需任何声明。
 * 它在服务器上渲染成 HTML，发送给浏览器，不向客户端暴露服务端逻辑。
 */

import Link from "next/link";

// 导出默认函数组件——App Router 约定：page.tsx 必须有默认导出。
export default function Chapter02OverviewPage() {
  return (
    <div>
      {/* ── 章节标题 ────────────────────────────────────────────── */}
      <h1>第 02 章 · 路由基础</h1>

      <p>
        本章聚焦 Next.js App Router 的核心约定：
        <strong>文件即路由</strong>。
        你将学会用文件夹和特殊文件名来定义页面、共享布局，以及用{" "}
        <code>{"<Link>"}</code> 做无刷新客户端导航。
      </p>

      {/* ── 一、文件系统路由 ─────────────────────────────────────── */}
      <h2>一、文件系统路由（File-system Routing）</h2>

      <p>
        App Router 把 <code>src/app/</code> 目录下的文件夹结构直接映射为 URL。
        只需要在文件夹里放一个 <code>page.tsx</code>，该路径就会成为一个可访问的页面。
        你不需要手动注册路由。
      </p>

      {/* 结构树：直观展示本项目的文件 → URL 映射关系 */}
      <pre>{`src/app/
├── layout.tsx      → 根布局（所有页面共享，含顶部栏和子导航）
├── page.tsx        → /              ← 你现在在这里
│
└── about/
    └── page.tsx    → /about`}</pre>

      <p className="muted" style={{ fontSize: "14px" }}>
        规律：每一层文件夹 = URL 里的一段路径。<code>page.tsx</code> 使该路径「可访问」，
        没有 <code>page.tsx</code> 的文件夹只是 URL 的一个中间段，不可直接访问。
      </p>

      {/* ── 二、page.tsx vs layout.tsx ─────────────────────────── */}
      <h2>二、page.tsx vs layout.tsx</h2>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
        {/* page.tsx */}
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <span className="tag">page.tsx</span>
          </p>
          <ul style={{ marginBottom: 0, paddingLeft: "18px" }}>
            <li>定义某个 URL 的页面内容。</li>
            <li>每次导航到该 URL 时都会重新渲染。</li>
            <li>必须默认导出一个 React 组件。</li>
            <li>
              接收 <code>params</code>（动态路由参数）和{" "}
              <code>searchParams</code>（Query 参数）作为 props。
            </li>
          </ul>
        </div>

        {/* layout.tsx */}
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <span className="tag">layout.tsx</span>
          </p>
          <ul style={{ marginBottom: 0, paddingLeft: "18px" }}>
            <li>定义该路由段及其所有子页面的共享外壳。</li>
            <li>子页面切换时，layout 不会重新渲染（状态保留）。</li>
            <li>必须接受并渲染 <code>children</code> prop。</li>
            <li>根 layout（<code>src/app/layout.tsx</code>）必须渲染 <code>{"<html>"}</code> 和 <code>{"<body>"}</code>；嵌套 layout 不需要也不应该渲染它们。</li>
          </ul>
        </div>
      </div>

      {/* ── 三、路由段 ───────────────────────────────────────────── */}
      <h2>三、路由段（Route Segment）</h2>

      <p>
        <code>src/app/</code> 下每一层文件夹都是一个「路由段」。URL 路径里的每一段
        <code>/xxx</code> 都对应一个文件夹名。
      </p>

      <div className="demo-box">
        <p style={{ marginTop: 0 }}>
          <strong>示例对应关系（本项目）</strong>
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", paddingBottom: "8px", color: "#9aa4b2" }}>文件路径</th>
              <th style={{ textAlign: "left", paddingBottom: "8px", color: "#9aa4b2" }}>URL</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["src/app/page.tsx", "/"],
              ["src/app/about/page.tsx", "/about"],
            ].map(([file, url]) => (
              <tr key={url}>
                <td style={{ paddingBottom: "6px", paddingRight: "24px" }}>
                  <code>{file}</code>
                </td>
                <td style={{ paddingBottom: "6px" }}>
                  <code style={{ color: "#6ea8fe" }}>{url}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── 四、Link 客户端导航 ──────────────────────────────────── */}
      <h2>四、{"<Link>"} 客户端导航</h2>

      <p>
        Next.js 提供了 <code>next/link</code> 的 <code>{"<Link>"}</code>{" "}
        组件来做页面间跳转。它与原生 <code>{"<a>"}</code> 的核心区别：
      </p>

      <div className="card">
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", paddingBottom: "8px", color: "#9aa4b2", width: "30%" }}>对比项</th>
              <th style={{ textAlign: "left", paddingBottom: "8px", color: "#9aa4b2" }}>{"<a href=...>"}</th>
              <th style={{ textAlign: "left", paddingBottom: "8px", color: "#9aa4b2" }}>{"<Link href=...>"}</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["页面刷新", "整页重新加载（白屏闪烁）", "客户端导航，无整页刷新"],
              ["JS/CSS", "全部重新下载解析", "只加载新页面的差量 chunk"],
              ["预取（Prefetch）", "无", "视口内链接自动预取（生产模式）"],
              ["共享状态", "丢失（layout 重新挂载）", "保留（layout 不重新渲染）"],
              ["用法", '<a href="/about">关于</a>', '<Link href="/about">关于</Link>'],
            ].map(([item, a, link]) => (
              <tr key={item}>
                <td style={{ paddingBottom: "8px", color: "#9aa4b2", verticalAlign: "top" }}>{item}</td>
                <td style={{ paddingBottom: "8px", paddingRight: "16px", verticalAlign: "top" }}>{a}</td>
                <td style={{ paddingBottom: "8px", color: "#6ea8fe", verticalAlign: "top" }}>{link}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        用 <code>{"<Link>"}</code> 导航时，Next.js 会利用浏览器的{" "}
        <a
          href="https://developer.mozilla.org/zh-CN/docs/Web/API/History_API"
          target="_blank"
          rel="noopener noreferrer"
        >
          History API
        </a>{" "}
        更新 URL，并只替换页面中变化的部分。共享的 layout 完全不参与重渲染。
      </p>

      {/* ── 导航到子页 ──────────────────────────────────────────── */}
      <h2>五、亲自试试</h2>

      <p>
        点击下方链接（或上方子导航）切换到「关于」子页，观察页面顶部的导航栏
        是否保持不变——它来自根布局，切换时不会闪烁或消失：
      </p>

      <div className="demo-box" style={{ textAlign: "center" }}>
        {/*
         * <Link> 的 href 是绝对路径（以 / 开头），更清晰、不易出错。
         * 本项目中 /about 对应 src/app/about/page.tsx。
         */}
        <Link
          href="/about"
          style={{
            display: "inline-block",
            padding: "10px 22px",
            borderRadius: "8px",
            background: "#6ea8fe",
            color: "#08111f",
            fontWeight: 600,
            fontSize: "15px",
          }}
        >
          前往「关于」子页 →
        </Link>
        <p className="muted" style={{ fontSize: "13px", marginBottom: 0 }}>
          使用 {"<Link>"} 导航，无整页刷新
        </p>
      </div>

      {/* ── 本章小结 ────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: "40px" }}>
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul>
          <li>
            <strong>文件即路由：</strong>在 <code>src/app/</code> 下建文件夹 +{" "}
            <code>page.tsx</code>，即可注册一个新 URL，无需手动配置路由表。
          </li>
          <li>
            <strong>page.tsx</strong> 定义页面内容；<strong>layout.tsx</strong>{" "}
            定义共享外壳（必须渲染 <code>children</code>）。
          </li>
          <li>
            <strong>根布局：</strong>子页面间切换时，根布局保持挂载，状态不丢失。
            根 layout 才写 <code>{"<html>"}</code>/<code>{"<body>"}</code>，嵌套 layout 不写。
          </li>
          <li>
            <strong>{"<Link>"}：</strong>用 <code>next/link</code> 做导航，避免整页刷新；
            生产模式下进入视口的链接会被自动预取，让页面跳转近乎瞬间。
          </li>
        </ul>
      </div>
    </div>
  );
}
