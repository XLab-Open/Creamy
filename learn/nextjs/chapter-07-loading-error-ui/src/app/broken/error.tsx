"use client";
/**
 * broken/error.tsx — 错误边界组件
 *
 * 文件位置：src/app/broken/error.tsx
 *
 * 为什么 error.tsx 必须是客户端组件？
 * ─────────────────────────────────────────────────────────────────
 * React 的错误边界（Error Boundary）机制本质上依赖类组件的
 * componentDidCatch / getDerivedStateFromError 生命周期，或者 Hook 形式的
 * 等价实现——这些都只存在于客户端 React 运行时。
 *
 * 服务端组件在服务器上执行，没有客户端 React 实例，因此无法持有「捕获错误后
 * 仍能继续渲染」所需的状态。error.tsx 必须是客户端组件，这样它才能：
 *   1. 在客户端挂载后接管错误处理逻辑。
 *   2. 持有可变状态（如重试次数），响应用户的「重试」点击。
 *   3. 调用 reset() 触发重新渲染尝试。
 *
 * Props 说明
 * ─────────────────────────────────────────────────────────────────
 * • error  : Error & { digest?: string }
 *     渲染期间抛出的错误对象。
 *     digest 是 Next.js 生成的服务端错误 ID，方便在日志中追踪（生产模式下
 *     不会把真实错误信息暴露给客户端，只暴露 digest）。
 *
 * • reset  : () => void
 *     调用此函数会让 Next.js 尝试重新渲染该路由段（重新执行 page.tsx）。
 *     如果错误是偶发的（如网络抖动），重试可能成功。
 *     如果错误是必现的（如本演示中的 throw），每次重试都会再次触发 error.tsx。
 *
 * 错误冒泡规则
 * ─────────────────────────────────────────────────────────────────
 * 错误会沿路由树向上冒泡，被最近的 error.tsx 捕获。
 * 如果当前目录没有 error.tsx，会继续向上找父级的 error.tsx，直到根级别。
 * 根布局（layout.tsx）的错误需要用 global-error.tsx（位于 src/app/）来捕获。
 */

// 注意：第一行必须是 "use client"，这是 Next.js 的硬性要求。
// 没有这一行，构建会报错：error.tsx must be a Client Component.

/**
 * ErrorBoundaryUI — error.tsx 的默认导出组件。
 *
 * Next.js 约定：error.tsx 必须默认导出一个接受 { error, reset } 的组件。
 */
export default function ErrorBoundaryUI({
  error,
  reset,
}: {
  /** 渲染期间抛出的错误对象 */
  error: Error & { digest?: string };
  /** 调用后尝试重新渲染该路由段 */
  reset: () => void;
}) {
  return (
    <div>
      <h1>错误边界演示页</h1>

      {/* 错误提示区域 */}
      <div
        className="demo-box"
        style={{
          border: "1px solid rgba(248, 113, 113, 0.4)",
          background: "rgba(248, 113, 113, 0.08)",
          marginBottom: "24px",
        }}
      >
        {/* 错误标题 */}
        <p
          style={{
            margin: "0 0 12px",
            color: "#f87171",
            fontWeight: 700,
            fontSize: "16px",
          }}
        >
          ❌ 渲染期间捕获到一个错误
        </p>

        {/* 错误消息：展示 error.message */}
        <p style={{ margin: "0 0 8px", fontFamily: "ui-monospace, monospace", fontSize: "14px" }}>
          {error.message}
        </p>

        {/*
         * digest：Next.js 在生产模式下会隐藏真实错误细节，但会附上一个 digest
         * 字符串（类似 "2847561230"），供服务端日志关联。开发模式下可能为空。
         */}
        {error.digest && (
          <p className="muted" style={{ margin: 0, fontSize: "12px" }}>
            错误追踪 ID（digest）：<code>{error.digest}</code>
          </p>
        )}
      </div>

      {/* 说明：这是 error.tsx 在工作 */}
      <div className="card" style={{ marginBottom: "24px" }}>
        <h2 style={{ marginTop: 0 }}>为什么看到这个页面？</h2>
        <p>
          同级的 <code>broken/page.tsx</code> 在渲染时执行了{" "}
          <code>{"throw new Error(...)"}</code>。Next.js 捕获了这个错误，并用{" "}
          <code>broken/error.tsx</code>（即你现在看到的这个组件）替代了原本的页面内容。
        </p>
        <p>
          真实场景中，错误可能来自：
        </p>
        <ul style={{ marginBottom: 0 }}>
          <li>await fetch() 失败（网络超时、服务端 5xx）</li>
          <li>数据库查询抛出异常</li>
          <li>JSON 解析出错（格式不符合预期）</li>
          <li>组件渲染逻辑中的未预期状态</li>
        </ul>
      </div>

      {/* 重试按钮：调用 reset() */}
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <button
          onClick={reset}
          className="btn"
          style={{ cursor: "pointer" }}
        >
          🔄 重试（调用 reset()）
        </button>
        <span className="muted" style={{ fontSize: "13px" }}>
          本演示中错误是必现的，每次重试都会再次触发此页面。
        </span>
      </div>

      {/* 重试说明 */}
      <p className="muted" style={{ fontSize: "13px", marginTop: "16px" }}>
        <strong>reset() 的作用：</strong>让 Next.js 尝试重新渲染该路由段（重新执行{" "}
        <code>page.tsx</code>）。若错误是偶发性的（如瞬时网络抖动），重试可能成功并恢复正常页面。
      </p>
    </div>
  );
}
