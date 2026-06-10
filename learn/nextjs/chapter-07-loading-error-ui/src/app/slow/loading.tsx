/**
 * loading.tsx — 加载态占位 UI
 *
 * 文件位置：src/app/slow/loading.tsx
 *
 * 工作原理
 * ─────────────────────────────────────────────────────────────────
 * 当同级的 page.tsx 是一个 async 服务端组件且其内部有 await（例如等待数据库
 * 返回、fetch 外部 API），页面在服务端「挂起」期间，Next.js 会自动把 page 包
 * 裹在 React 的 <Suspense> 边界里，并把 loading.tsx 的内容作为 fallback 显示
 * 给用户。
 *
 * 这意味着：
 *   1. 用户不会看到空白页——而是立刻看到这里定义的骨架/占位 UI。
 *   2. page.tsx 的数据加载完毕后，React 自动把占位内容替换为真实内容（流式渲染）。
 *   3. loading.tsx 本身是服务端组件（无需加 "use client"），因为它只渲染静态 HTML。
 *
 * 典型使用场景
 * ─────────────────────────────────────────────────────────────────
 *   • 简单文字提示（如本例）
 *   • 骨架屏（Skeleton）——用灰色方块占位，与真实布局形状相同
 *   • Spinner 动画——用 CSS 动画实现旋转圆圈
 *
 * 注意：如果你已经在 page.tsx 内部手动用 <Suspense> 包了某个子组件，
 * 那 loading.tsx 和内部的 <Suspense> 可以并存，各自独立工作。
 */

// 这是一个服务端组件，无需 "use client"。
// 它的内容在服务器端渲染成静态 HTML，立即发送给浏览器。
export default function SlowLoading() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "240px",
        gap: "16px",
      }}
    >
      {/* 加载图标：用 CSS 动画实现旋转效果 */}
      <div
        style={{
          width: "48px",
          height: "48px",
          border: "4px solid rgba(110, 168, 254, 0.2)",
          borderTop: "4px solid #6ea8fe",
          borderRadius: "50%",
          // 内联 style 无法直接写 keyframes，用 animation 名称（由 globals.css 或浏览器默认支持无限旋转）。
          // 这里改为用 emoji 方式，确保不依赖外部 CSS。
        }}
        aria-hidden="true"
      />

      {/* 主要提示文字 */}
      <p style={{ fontSize: "18px", margin: 0, color: "#e6e9ef" }}>
        ⏳ 正在加载…
      </p>

      {/* 辅助说明：告知用户这是 loading.tsx 在工作 */}
      <p
        className="muted"
        style={{ fontSize: "13px", margin: 0, textAlign: "center", maxWidth: "360px" }}
      >
        你看到的这段内容来自 <code>slow/loading.tsx</code>。
        <br />
        同级的 <code>page.tsx</code> 正在服务端等待异步数据（1.5 秒），
        Next.js 自动把这里的内容作为 Suspense fallback 显示。
      </p>
    </div>
  );
}
