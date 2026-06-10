/**
 * 第 05 章：数据获取与缓存 (Data Fetching & Caching)
 *
 * 路由：/（根路由，独立项目）
 *
 * 本页面展示三个核心概念：
 *   1. async 服务端组件直接 await 取数据（最简单的数据获取方式）。
 *   2. <Suspense> 包裹慢组件，实现 streaming：页面外壳先到，慢内容后到。
 *   3. fetch() 的三种缓存配置写法（代码示例 + 注释）。
 *
 * 重要：本页面是一个「服务端组件」（没有 "use client"），
 *       因此可以直接写 async/await，所有取数逻辑都在服务器上执行。
 */

// React 19 的 Suspense 是流式渲染的关键 —— 仅此一个 import，无需额外依赖。
import { Suspense } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// 1. 本地「模拟数据库」函数
//    真实项目中这里会是 fetch()、ORM 查询、调用第三方 SDK 等。
//    我们用 setTimeout 模拟 800ms 的网络/数据库延迟。
// ─────────────────────────────────────────────────────────────────────────────

/** 模拟用户数据类型 */
type User = {
  id: number;
  name: string;
  role: string;
  joinedAt: string;
};

/**
 * getUser —— 模拟「慢一点的数据库查询」(800ms)。
 *
 * 在真实项目里你会写：
 *   const user = await db.users.findFirst({ where: { id } });
 * 或者：
 *   const res = await fetch("https://api.example.com/user/1");
 *   const user = await res.json();
 *
 * 关键点：这个函数只在服务端执行，API 密钥、数据库连接串都不会泄露到浏览器。
 */
async function getUser(): Promise<User> {
  // 模拟 800ms 延迟（相当于一次真实的数据库往返）
  await new Promise<void>((r) => setTimeout(r, 800));

  return {
    id: 42,
    name: "李明",
    role: "前端开发者",
    joinedAt: "2024-03-01",
  };
}

/** 模拟统计数据类型 */
type Stats = {
  commits: number;
  pullRequests: number;
  reviewedLines: number;
};

/**
 * getStats —— 模拟「更慢的分析数据查询」(1500ms)。
 *
 * 这个函数会被 <SlowStats /> 组件调用，
 * 配合 <Suspense> 演示 streaming：
 *   • 外层页面（含 getUser）先返回给浏览器
 *   • 1.5s 后 SlowStats 的内容再「流式补充」进来
 */
async function getStats(): Promise<Stats> {
  // 模拟 1500ms 延迟
  await new Promise<void>((r) => setTimeout(r, 1500));

  return {
    commits: 312,
    pullRequests: 47,
    reviewedLines: 28_640,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 慢子组件 SlowStats
//    async 函数组件 —— React 19 / Next.js 15 的 RSC 原生支持。
//    它内部直接 await getStats()，不需要 useState / useEffect。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SlowStats —— 一个「慢」的 async 服务端组件。
 *
 * 它会被 <Suspense> 包裹：在 1.5s 的 await 完成之前，
 * 父页面会先把 fallback UI（加载提示）发送给浏览器，
 * 1.5s 后再把本组件的真实 HTML 流式补充（streaming）进来。
 *
 * 用户体验：页面不是「等 1.5s 后才出现」，而是「先看到外壳，
 * 数据好了再悄悄填充」——更快的感知首屏。
 */
async function SlowStats() {
  // 直接 await —— 不需要任何 hook，代码简洁到不像话。
  const stats = await getStats();

  return (
    <div className="demo-box">
      {/* 标题说明这是流式补充进来的内容 */}
      <p className="muted" style={{ marginTop: 0, fontSize: "13px" }}>
        ↓ 此区块由 Suspense streaming 延迟补充（模拟 1.5 秒后到达）
      </p>
      <h3 style={{ marginTop: 0 }}>本月统计数据</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "16px",
        }}
      >
        {/* 提交数 */}
        <div className="card" style={{ textAlign: "center", margin: 0 }}>
          <div
            style={{ fontSize: "28px", fontWeight: 700, color: "#6ea8fe" }}
          >
            {stats.commits}
          </div>
          <div className="muted" style={{ fontSize: "13px" }}>
            Commits
          </div>
        </div>
        {/* PR 数 */}
        <div className="card" style={{ textAlign: "center", margin: 0 }}>
          <div
            style={{ fontSize: "28px", fontWeight: 700, color: "#6ea8fe" }}
          >
            {stats.pullRequests}
          </div>
          <div className="muted" style={{ fontSize: "13px" }}>
            Pull Requests
          </div>
        </div>
        {/* Review 行数 */}
        <div className="card" style={{ textAlign: "center", margin: 0 }}>
          <div
            style={{ fontSize: "28px", fontWeight: 700, color: "#6ea8fe" }}
          >
            {stats.reviewedLines.toLocaleString()}
          </div>
          <div className="muted" style={{ fontSize: "13px" }}>
            已 Review 行数
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. fetch() 三种缓存模式的代码示例字符串
//    因为没有真实 API，我们用 <pre><code> 展示代码 + 注释，原理一样清晰。
// ─────────────────────────────────────────────────────────────────────────────

const fetchExamples = `// ① no-store —— 禁用缓存，每次请求都实时获取最新数据（完全动态渲染）
//    适用场景：实时数据、用户特定内容、需要最新状态的页面
const res1 = await fetch("https://api.example.com/data", {
  cache: "no-store",
});

// ② force-cache —— 强制使用缓存（Next.js 15 中已不是默认值，需显式指定）
//    适用场景：不经常变化的公共数据（商品分类、配置项等）
//    注意：Next.js 15 把默认行为改为 no-store，与 15 以前版本不同！
const res2 = await fetch("https://api.example.com/data", {
  cache: "force-cache",
});

// ③ revalidate —— ISR（增量静态再生成）：先返回缓存，后台悄悄刷新
//    适用场景：博客文章、产品详情等允许「几十秒内有点旧」的数据
//    revalidate: 60 表示「最多 60 秒后，下次访问时触发后台重新获取」
const res3 = await fetch("https://api.example.com/data", {
  next: { revalidate: 60 },
});

// ✦ 也可以在「路由段」级别设置，用 export const revalidate = 60 写在 page.tsx 顶部
//   这样整张页面所有 fetch 都默认使用该 revalidate 时长。`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. 页面主体 —— async 服务端组件
//    直接 await getUser()，无需 useState/useEffect/loading 状态管理。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HomePage —— 本章的页面入口组件（根路由 /）。
 *
 * 这个组件是 async 的服务端组件。
 * Next.js 在服务端渲染时会 await 这个函数，取到数据后再生成 HTML 发给浏览器。
 * 用户拿到的是已填充好数据的页面，不需要浏览器再发一次请求。
 */
export default async function HomePage() {
  // ── 服务端组件直接 await 取数 ──────────────────────────────────────
  // 这一行代码就是「数据获取」的全部：一个普通的 await 调用。
  // 没有 useEffect，没有 loading state，没有 try/catch 包在组件里，
  // 错误会自动冒泡到最近的 error.tsx（第 07 章会讲）。
  const user = await getUser();
  // ─────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* ── 章节标题 ─────────────────────────────────────────────── */}
      <span className="tag">Chapter 05 · Data Fetching</span>
      <h1>第 05 章 · 数据获取与缓存</h1>
      <p className="muted">
        App Router 中，服务端组件可以是 <code>async</code> 函数，直接{" "}
        <code>await</code> 取数据后渲染——零 boilerplate，零客户端请求。
        本章同时讲解 <code>fetch()</code> 的三种缓存策略，以及用{" "}
        <code>{"<Suspense>"}</code> 实现 streaming 加速首屏。
      </p>

      {/* ── DEMO 1：async 服务端组件直接 await 取数 ──────────────── */}
      <h2>① 服务端组件直接 await 取数</h2>
      <p>
        下方数据由 <code>getUser()</code> 提供（模拟 800ms 延迟）。
        页面级 <code>await getUser()</code> 在服务端执行完毕后，
        Next.js 才开始生成 HTML 发给浏览器——用户看到的永远是「已有数据」的页面。
      </p>

      {/*
       * 展示服务端取到的数据。
       * 注意：这里没有任何「加载中」状态——因为 await 在服务端已经等完了。
       */}
      <div className="demo-box">
        <p className="muted" style={{ marginTop: 0, fontSize: "13px" }}>
          服务端 await getUser() → 直接渲染（无客户端二次请求）
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            gap: "8px 24px",
            alignItems: "center",
          }}
        >
          <span className="muted">用户 ID</span>
          <span>
            <code>{user.id}</code>
          </span>
          <span className="muted">姓名</span>
          <strong>{user.name}</strong>
          <span className="muted">角色</span>
          <span>{user.role}</span>
          <span className="muted">加入时间</span>
          <span>{user.joinedAt}</span>
        </div>
      </div>

      {/* ── DEMO 2：Suspense + 慢组件 streaming ─────────────────── */}
      <h2>② {"<Suspense>"} + streaming：慢组件不阻塞外壳</h2>
      <p>
        <code>{"<SlowStats />"}</code> 内部需要 1.5 秒才能取到数据。
        如果不用 Suspense，整张页面都要等 1.5s。
        用 <code>{"<Suspense fallback={...}>"}</code> 包裹后：
      </p>
      <ul style={{ color: "var(--muted)", fontSize: "14px" }}>
        <li>
          浏览器<strong style={{ color: "var(--text)" }}>立即</strong>收到页面外壳（标题、用户卡片等）
        </li>
        <li>
          服务器继续在后台 await SlowStats 的数据
        </li>
        <li>
          1.5s 后数据就绪，把该区块的 HTML <strong style={{ color: "var(--text)" }}>流式追加</strong>给浏览器
        </li>
        <li>
          React 在客户端用真实内容替换 fallback —— 用户看到无缝切换
        </li>
      </ul>

      {/*
       * <Suspense> 的关键用法：
       *   fallback —— 数据未就绪时显示的占位 UI
       *   children  —— 慢 async 组件，就绪后替换 fallback
       *
       * Next.js 会把 <SlowStats /> 的渲染推迟到其 await 完成，
       * 此前会先把 fallback 的 HTML 发给浏览器（streaming）。
       */}
      <Suspense
        fallback={
          <div
            className="demo-box"
            style={{ textAlign: "center", color: "var(--muted)" }}
          >
            <span
              style={{
                display: "inline-block",
                animation: "pulse 1.2s ease-in-out infinite",
              }}
            >
              ⏳
            </span>{" "}
            统计数据加载中（模拟 1.5 秒延迟）……
            <style>{`
              @keyframes pulse {
                0%, 100% { opacity: 1; }
                50%       { opacity: 0.3; }
              }
            `}</style>
          </div>
        }
      >
        {/* SlowStats 是 async 组件，在服务端 await 1.5s 后流式补充进来 */}
        <SlowStats />
      </Suspense>

      {/* ── DEMO 3：fetch() 缓存策略代码示例 ─────────────────────── */}
      <h2>③ fetch() 的三种缓存配置</h2>
      <p>
        Next.js 对原生 <code>fetch()</code> 进行了增强，
        可以通过第二个参数控制缓存行为。以下三种是最常用的模式：
      </p>

      {/* 三种模式简介卡片 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "12px",
          marginBottom: "20px",
        }}
      >
        {/* no-store */}
        <div className="card" style={{ margin: 0 }}>
          <div>
            <span className="tag">动态</span>
          </div>
          <strong style={{ display: "block", margin: "8px 0 4px" }}>
            no-store
          </strong>
          <p className="muted" style={{ fontSize: "13px", margin: 0 }}>
            每次请求实时获取，不使用任何缓存。
            适合实时数据、用户个性化内容。
          </p>
        </div>
        {/* force-cache */}
        <div className="card" style={{ margin: 0 }}>
          <div>
            <span className="tag">静态</span>
          </div>
          <strong style={{ display: "block", margin: "8px 0 4px" }}>
            force-cache
          </strong>
          <p className="muted" style={{ fontSize: "13px", margin: 0 }}>
            强制读缓存，构建时/首次请求后永久复用。
            适合几乎不变的公共数据。
          </p>
        </div>
        {/* revalidate */}
        <div className="card" style={{ margin: 0 }}>
          <div>
            <span className="tag">ISR</span>
          </div>
          <strong style={{ display: "block", margin: "8px 0 4px" }}>
            revalidate: N
          </strong>
          <p className="muted" style={{ fontSize: "13px", margin: 0 }}>
            N 秒后在后台悄悄刷新，用户始终秒开。
            适合博客、产品详情等。
          </p>
        </div>
      </div>

      {/* 代码示例 */}
      <pre>
        <code>{fetchExamples}</code>
      </pre>

      {/* ── 本章小结 ─────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: "40px" }}>
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul style={{ paddingLeft: "20px", lineHeight: "2" }}>
          <li>
            <strong>服务端组件 = async 函数</strong>：直接{" "}
            <code>await</code> 取数，无需 useState/useEffect，代码最简洁。
          </li>
          <li>
            <strong>fetch 缓存三模式</strong>：
            <code>no-store</code>（实时）、
            <code>force-cache</code>（永久缓存）、
            <code>next.revalidate</code>（ISR 定时刷新）。
          </li>
          <li>
            <strong>{"<Suspense>"} 实现 streaming</strong>：
            慢组件不再阻塞外壳，用户感知首屏更快，并行加载多个数据源。
          </li>
          <li>
            <strong>Next.js 15 默认行为变化</strong>：
            <code>fetch()</code> 默认已改为 <code>no-store</code>，
            需要缓存必须显式声明。
          </li>
          <li>
            <strong>常见坑</strong>：客户端组件（有 "use client"）里
            不能直接写 <code>await</code> 在组件顶层——
            需要用 <code>useEffect</code> 或移到服务端。
          </li>
        </ul>
      </div>
    </div>
  );
}
