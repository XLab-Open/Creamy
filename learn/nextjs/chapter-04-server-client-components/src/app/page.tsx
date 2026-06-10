/**
 * page.tsx —— 第 04 章页面（服务端组件）
 *
 * 这个文件本身就是一个「服务端组件（RSC）」。
 *
 * 判断依据：
 * ─────────────────────────────────────────────────────────────────────────
 * - 文件顶部没有 "use client" → App Router 默认处理为服务端组件。
 * - 组件函数体在 Node.js 环境中执行，不会把这里的 JS 发给浏览器。
 * - 你可以直接 await 数据库、读取文件系统、使用 process.env 里的密钥，
 *   而不用担心它们暴露在客户端 bundle 里。
 *
 * 与 Counter.tsx（客户端组件）的关系：
 * ─────────────────────────────────────────────────────────────────────────
 * 服务端组件可以 import 并渲染客户端组件。
 * Next.js 会：
 *   1. 在服务器上先渲染这个页面（生成 Counter 的初始 HTML shell）；
 *   2. 把 Counter.tsx 的 JS bundle 发给浏览器；
 *   3. 浏览器收到 HTML 后用 JS 进行「hydration」，Counter 从而具备交互能力。
 *
 * 这两步协作让我们兼得：
 *   - 首屏快（服务端渲染 HTML，无需等 JS 下载）
 *   - 交互丰富（hydration 后 Counter 像普通 React 组件一样工作）
 */

// ★ 这里没有 "use client"，所以本文件是服务端组件 ★

import Counter from "./Counter";

/**
 * 服务端「数据准备」示例。
 *
 * 在真实应用里这里可以是：
 *   const posts = await db.query("SELECT ...");
 *   const secret = process.env.MY_SECRET_KEY;  // 绝不会泄露到浏览器
 *
 * 为了让教程可以离线运行、避免 hydration 不匹配，这里使用：
 * - 固定数字作为计数器初始值（随机值在 SSR 与客户端 hydration 时可能不一致，
 *   导致 React 报 "Hydration Mismatch" 警告，这是经典的服务端/客户端坑之一）。
 * - 服务器时间字符串（仅在服务器渲染时计算一次，展示"在服务端执行"的感觉）。
 */
const COUNTER_INITIAL = 5; // 固定初始值，避免 hydration 不匹配

// 注意：下面这行代码运行在 Node.js 里，不会出现在浏览器 JS 包中。
// 如果你在浏览器 DevTools → Sources 里搜索这段字符串，你找不到它。
const serverRenderedAt = new Date().toLocaleString("zh-CN", {
  timeZone: "Asia/Shanghai",
});

export default function Chapter04Page() {
  // ──────────────────────────────────────────────────────────────────────
  // 服务端组件的「限制」验证：
  // 如果你在这里写 const [x, setX] = useState(0)，Next.js 会报错：
  //   Error: useState is not supported in Server Components.
  // 同样，onClick 等事件处理器也无法在服务端组件里定义。
  // ──────────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* ── 章节标题 ─────────────────────────────────────────────── */}
      <span className="tag">RSC · "use client" · Hydration</span>
      <h1>第 04 章 · 服务端组件 vs 客户端组件</h1>
      <p className="muted">
        App Router 中的组件分为两类。理解它们的边界和协作方式，
        是高效使用 Next.js 的核心。本章用一个可交互的 demo 展示二者如何配合。
      </p>

      {/* ── 服务端数据展示 ───────────────────────────────────────── */}
      <div className="card">
        <p style={{ marginTop: 0 }}>
          <strong>服务端渲染时间（仅在服务器上计算）</strong>
        </p>
        <p>
          <code>{serverRenderedAt}</code>
        </p>
        <p className="muted" style={{ marginBottom: 0, fontSize: "13px" }}>
          这行时间字符串在 Node.js 里生成，不存在于浏览器 JS bundle。
          刷新页面才会更新（每次 SSR 重新执行）。
          你可以在 DevTools → Network → 查看 HTML 响应来确认它是服务端输出的。
        </p>
      </div>

      {/* ── 核心概念：对比表 ─────────────────────────────────────── */}
      <h2>服务端组件 vs 客户端组件：能力对比</h2>
      <p className="muted">
        下表列出两类组件各自能做和不能做的事情，帮助你快速建立判断直觉。
      </p>

      <div
        style={{
          overflowX: "auto",
          border: "1px solid #232a36",
          borderRadius: "10px",
          marginBottom: "24px",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "14px",
          }}
        >
          <thead>
            <tr style={{ background: "#141821", borderBottom: "1px solid #232a36" }}>
              <th style={{ padding: "12px 16px", textAlign: "left", color: "#9aa4b2", fontWeight: 600 }}>
                能力 / 场景
              </th>
              <th style={{ padding: "12px 16px", textAlign: "center", color: "#6ea8fe", fontWeight: 600 }}>
                服务端组件 (RSC)
              </th>
              <th style={{ padding: "12px 16px", textAlign: "center", color: "#8fdb70", fontWeight: 600 }}>
                客户端组件 ("use client")
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              ["直接 await 数据库 / 文件系统", "✅", "❌"],
              ["使用 process.env 中的密钥（不暴露给浏览器）", "✅", "❌（会打包进 bundle）"],
              ["访问 Node.js 原生模块（fs、crypto 等）", "✅", "❌"],
              ["代码进入浏览器 JS bundle", "❌（不发给浏览器）", "✅"],
              ["useState / useReducer / useRef", "❌", "✅"],
              ["useEffect / useLayoutEffect", "❌", "✅"],
              ["onClick / onChange 等事件处理器", "❌", "✅"],
              ["使用浏览器 API（window、document、localStorage）", "❌", "✅"],
              ["可以 import 并渲染客户端组件", "✅", "✅"],
              ["可以 import 并渲染服务端组件", "✅（直接渲染）", "⚠️（只能通过 children prop 传入）"],
              ["首屏 HTML 输出（SEO 友好）", "✅（直接生成 HTML）", "✅（SSR + hydration）"],
            ].map(([feature, rsc, cc], i) => (
              <tr
                key={i}
                style={{
                  borderBottom: "1px solid #232a36",
                  background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
                }}
              >
                <td style={{ padding: "10px 16px" }}>{feature}</td>
                <td style={{ padding: "10px 16px", textAlign: "center" }}>{rsc}</td>
                <td style={{ padding: "10px 16px", textAlign: "center" }}>{cc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── "use client" 边界概念说明 ────────────────────────────── */}
      <h2>"use client" 边界</h2>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          <strong>边界的含义：</strong>
          <code>"use client"</code> 不是给「整个应用」打的标签，而是一条
          <strong>边界声明</strong>——它告诉 Next.js：
          「从这个文件开始，下面的组件树要在客户端运行。」
        </p>
        <ul style={{ paddingLeft: "20px", marginBottom: 0 }}>
          <li style={{ marginBottom: "8px" }}>
            <strong>边界向下传染：</strong>一旦某个文件写了 <code>"use client"</code>，
            它 import 的所有模块也自动进入客户端 bundle，无需在每个子文件重复声明。
          </li>
          <li style={{ marginBottom: "8px" }}>
            <strong>尽量下沉边界：</strong>把 <code>"use client"</code> 放到尽可能「叶子」的组件，
            只包裹真正需要交互的最小部分。上层保持服务端组件，
            这样服务端组件部分的代码不会进入 bundle，减少传输体积。
          </li>
          <li>
            <strong>本页的例子：</strong>
            <code>page.tsx</code>（本文件，服务端组件）→ 渲染 →
            <code>Counter.tsx</code>（客户端组件，有 <code>"use client"</code>）。
            Counter 及其依赖进入 bundle；page.tsx 本身的代码不会。
          </li>
        </ul>
      </div>

      {/* ── 组件树示意图 ─────────────────────────────────────────── */}
      <h2>本页的组件树结构</h2>

      <div className="card">
        <pre style={{ margin: 0, fontSize: "13px", lineHeight: "1.8" }}>
          <code>{`app/layout.tsx     ← 服务端组件（根布局）
└── page.tsx       ← 服务端组件（本文件，你在这里）
    └── Counter.tsx ← ★ 客户端组件（"use client" 边界）
                          └── useState、onClick 等都在这里`}</code>
        </pre>
        <p className="muted" style={{ marginBottom: 0, fontSize: "13px", marginTop: "12px" }}>
          服务端组件（page.tsx）在服务器上执行，把 <code>label</code> 和 <code>initial</code>
          作为普通 props 序列化后传给 Counter。Counter 在服务器上先生成 HTML，
          再在浏览器里 hydrate 变成可交互组件。
        </p>
      </div>

      {/* ── 实际 Demo：服务端组件渲染客户端组件 ─────────────────── */}
      <h2>Demo：服务端把数据作为 props 传给客户端组件</h2>

      <p className="muted">
        下面的 <code>Counter</code> 是客户端组件（<code>Counter.tsx</code> 第一行有 <code>"use client"</code>）。
        它的 <code>label</code> 和 <code>initial</code> 由本页（服务端组件）计算后以 props 传入。
        试着点击按钮：状态变化完全在浏览器内完成，不发起任何网络请求。
      </p>

      {/*
       * 服务端组件渲染客户端组件。
       * 注意传入的 props 都是可序列化的值（string、number）。
       * 不能传函数：onClick={() => ...} 作为 prop 传给客户端组件会报序列化错误。
       */}
      <Counter label="点击计数" initial={COUNTER_INITIAL} />

      {/* ── props 序列化说明 ─────────────────────────────────────── */}
      <div className="card">
        <p style={{ marginTop: 0 }}>
          <strong>Props 必须可序列化</strong>
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          服务端组件跨越「服务端→客户端」边界传递 props 时，数据需要被序列化（类似 JSON）。
          <br />
          ✅ 可以传：<code>string</code>、<code>number</code>、<code>boolean</code>、
          普通对象、数组、<code>null</code>、<code>undefined</code>
          <br />
          ❌ 不能传：<code>Function</code>、<code>Date</code>（需转字符串）、
          <code>Map</code>/<code>Set</code>（需转数组/对象）、类实例、<code>Symbol</code>
          <br />
          ⚠️ 唯一例外：Server Actions——以 <code>"use server"</code> 标记的函数可以作为 props 传递，
          但那是第 08 章的话题。
        </p>
      </div>

      {/* ── 常见误区提示 ─────────────────────────────────────────── */}
      <h2>常见坑 ⚠️</h2>

      <div className="card">
        <ul style={{ paddingLeft: "20px", margin: 0 }}>
          <li style={{ marginBottom: "12px" }}>
            <strong>在服务端组件里用 useState：</strong>
            直接报错 <code>useState is not supported in Server Components</code>。
            解决：把需要 state 的部分拆出到独立文件并加 <code>"use client"</code>。
          </li>
          <li style={{ marginBottom: "12px" }}>
            <strong>把 "use client" 放太高：</strong>
            例如在根 Layout 加 <code>"use client"</code>，会导致整棵组件树都进客户端 bundle，
            失去 RSC 的性能优势。应该只在最小的交互叶子组件上加。
          </li>
          <li style={{ marginBottom: "12px" }}>
            <strong>Hydration Mismatch（水合不匹配）：</strong>
            服务端渲染的 HTML 和客户端 hydration 时的渲染结果不一致，
            React 会警告。常见原因：用 <code>Math.random()</code>、<code>Date.now()</code>
            这类在两端结果不同的表达式初始化状态。
            解决：使用固定值初始化（如本章的 <code>COUNTER_INITIAL = 5</code>），
            或将随机逻辑移入 <code>useEffect</code>（只在客户端执行）。
          </li>
          <li>
            <strong>误以为客户端组件"不做 SSR"：</strong>
            错误。客户端组件在服务器上依然会做一次 SSR（生成初始 HTML），
            然后在浏览器 hydrate。<code>"use client"</code> 的意思是
            「需要客户端 JS 运行时」，而不是「跳过服务端渲染」。
          </li>
        </ul>
      </div>

      {/* ── 本章小结 ─────────────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul style={{ paddingLeft: "20px", margin: 0 }}>
          <li style={{ marginBottom: "8px" }}>
            App Router 中所有组件<strong>默认是服务端组件（RSC）</strong>：
            在服务器执行，代码不入 bundle，可直接访问后端资源。
          </li>
          <li style={{ marginBottom: "8px" }}>
            需要 <code>useState</code>、事件处理、浏览器 API 的组件，
            在文件<strong>第一行</strong>写 <code>"use client"</code>，成为客户端组件。
          </li>
          <li style={{ marginBottom: "8px" }}>
            服务端组件<strong>可以渲染</strong>客户端组件；
            传递的 props 必须是<strong>可序列化</strong>的值。
          </li>
          <li style={{ marginBottom: "8px" }}>
            <code>"use client"</code> 边界<strong>向下传染</strong>其 import 树；
            尽量把边界<strong>下沉</strong>到叶子组件，减少 bundle 体积。
          </li>
          <li>
            客户端组件依然做 SSR（首屏 HTML），之后在浏览器 hydrate；
            避免服务端与客户端渲染结果不一致导致 Hydration Mismatch。
          </li>
        </ul>
      </div>
    </div>
  );
}
