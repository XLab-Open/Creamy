/**
 * 「关于」子页 (About Sub-page)
 *
 * 文件位置：src/app/about/page.tsx
 * 访问 URL ：/about
 *
 * URL 由文件夹层级自动决定——规则极其简单：
 *   src/app/
 *     about/        → URL 段 /about
 *       page.tsx    → 使该路径可访问，最终 URL 为 /about
 *
 * 你不需要在任何地方"注册"这个路由，放上文件即生效。
 *
 * 这个页面证明了根布局的状态保留行为：
 * 从 / 切换到 /about 时，src/app/layout.tsx 里的顶部栏和子导航依然在，
 * 因为根布局不会因子页面切换而重新挂载——只有 <main> 里的 children 被替换。
 *
 * 这是服务端组件（Server Component），默认如此，无需任何声明。
 */

import Link from "next/link";

export default function Chapter02AboutPage() {
  return (
    <div>
      {/* ── 页面标题 ────────────────────────────────────────────── */}
      <h1>第 02 章 · 路由基础</h1>

      {/* 当前页的标识 */}
      <div
        className="demo-box"
        style={{ display: "flex", alignItems: "center", gap: "12px" }}
      >
        <span className="tag">子页面</span>
        <span>
          你现在在 <code>/about</code>
        </span>
      </div>

      {/* ── 说明内容 ─────────────────────────────────────────────── */}
      <h2>根布局状态保留验证</h2>

      <p>
        请注意页面上方的导航（概览 / 关于）仍然存在——它由{" "}
        <code>src/app/layout.tsx</code>（根布局）渲染。
        从 <code>/</code> 跳转到 <code>/about</code> 时，Next.js 只替换了 <code>{"<main>"}</code>{" "}
        里的 <code>children</code> 部分，根布局本身没有重新挂载。
      </p>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          <strong>渲染层级示意</strong>
        </p>
        {/*
         * 用 pre 展示布局嵌套关系，帮助初学者建立心智模型。
         * 本项目只有根布局一层，没有额外的嵌套布局。
         * 根布局 → 当前页面，由外到内嵌套。
         */}
        <pre style={{ marginBottom: 0 }}>{`<RootLayout>    ← src/app/layout.tsx（顶部栏 + 子导航，保持挂载）
  <AboutPage /> ← src/app/about/page.tsx（你在这里，切换时被替换）
</RootLayout>`}</pre>
      </div>

      <h2>文件夹即路径段</h2>

      <p>
        {/*
         * URL 由文件夹层级决定：about/ 文件夹名直接成为 URL 的一段。
         * 规律：文件夹层级 = URL 层级，无需任何额外配置。
         */}
        <code>about/</code> 文件夹名直接成为 URL 的一段。
        规律非常简单：<strong>文件夹层级 = URL 层级</strong>。
        想新增一个 <code>/about/team</code> 页面，
        只需在 <code>about/</code> 下再建 <code>team/page.tsx</code> 即可，
        不需要任何路由配置。
      </p>

      <div className="demo-box">
        <p style={{ marginTop: 0, marginBottom: "10px" }}>
          <strong>继续深挖：如果再新建一个子页</strong>
        </p>
        <pre style={{ marginBottom: 0 }}>{`about/
├── page.tsx        → /about
└── team/
    └── page.tsx    → /about/team  （可自行新建试试）`}</pre>
      </div>

      {/* ── Link 返回概览 ────────────────────────────────────────── */}
      <p>
        完成观察后，用 <code>{"<Link>"}</code> 返回概览页——注意浏览器不会整页刷新：
      </p>

      {/*
       * Link 做返回导航，href 指向根路径 /（对应 src/app/page.tsx）。
       * 用户点击后，Next.js 用客户端导航替换 <main> 内容区，
       * 根布局不会重新挂载。
       */}
      <Link
        href="/"
        style={{
          display: "inline-block",
          padding: "10px 22px",
          borderRadius: "8px",
          background: "rgba(110,168,254,0.12)",
          color: "#6ea8fe",
          fontWeight: 600,
          fontSize: "15px",
          border: "1px solid rgba(110,168,254,0.3)",
        }}
      >
        ← 返回概览页
      </Link>

      {/* ── 本章小结（在子页也放一份，方便对比） ───────────────── */}
      <div className="card" style={{ marginTop: "40px" }}>
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul>
          <li>
            子页面的 URL 由文件夹嵌套层级自动决定，无需手动注册。
          </li>
          <li>
            切换子页面时，根 layout 不会重新挂载，只有 <code>{"<main>"}</code>{" "}
            里的 <code>children</code> 部分被替换——这正是 Next.js 性能优秀的原因之一。
          </li>
          <li>
            <code>{"<Link>"}</code> 比原生 <code>{"<a>"}</code>{" "}
            更适合应用内导航：客户端跳转、无白屏、自动预取。
          </li>
        </ul>
      </div>
    </div>
  );
}
