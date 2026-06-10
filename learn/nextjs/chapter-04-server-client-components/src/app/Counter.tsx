/**
 * Counter.tsx —— 客户端组件示例
 *
 * ★ 第一行必须是 "use client" ★
 *
 * 为什么必须标记 "use client"？
 * ─────────────────────────────────────────────────────────────────────────
 * 1. App Router 中，所有组件默认是「服务端组件（RSC）」。
 *    服务端组件在 Node.js 环境中渲染，输出的是 HTML 或 React 服务端负载，
 *    根本没有浏览器运行时，因此不能使用任何浏览器/React 交互特性。
 *
 * 2. useState 是 React 的运行时状态钩子（Hook），它依赖浏览器端的 JavaScript
 *    执行来维护状态。如果在服务端组件里调用 useState，Next.js 会在编译时
 *    抛出错误："useState" only works in a Client Component。
 *
 * 3. 事件处理器（onClick 等）同理：浏览器事件监听必须在客户端运行，
 *    服务端组件里写 onClick 无法序列化为 HTML，也会报错。
 *
 * 4. "use client" 的作用：
 *    - 声明本文件（及其所有 import）是「客户端组件树」的起点（边界）。
 *    - Next.js 会把这个文件及其依赖打包进发送到浏览器的 JavaScript bundle。
 *    - 组件依然会在服务器上做 SSR（生成初始 HTML），然后在浏览器上「hydrate」
 *      （重新接管 DOM，挂载事件监听、恢复 state），实现交互。
 *
 * 5. 边界向下传染：一旦某个文件写了 "use client"，它所 import 的模块
 *    也会自动进入客户端 bundle——无需在每个子文件都重复声明。
 *    因此：把 "use client" 边界尽量下沉到叶子组件，只包裹真正需要交互
 *    的最小部分，其余保持服务端组件以减小 bundle 体积。
 */
"use client";

import { useState } from "react";

/**
 * Counter 的 Props 定义。
 *
 * 注意：这些 props 由父级「服务端组件」传入。
 * 服务端组件向客户端组件传递 props 时，数据必须是「可序列化」的值——
 * 字符串、数字、布尔值、数组、普通对象都可以，
 * 但函数、类实例、Symbol 等不可序列化的值会导致运行时错误。
 * （Server Actions 是唯一例外，但那是另一个机制。）
 */
interface CounterProps {
  /** 计数器的标签文字，由服务端组件传入，演示"服务端数据→客户端 props" */
  label: string;
  /** 计数器的初始值，由服务端组件传入 */
  initial: number;
}

/**
 * Counter —— 带 +1 / -1 / 重置 按钮的交互式计数器。
 *
 * 这是一个「客户端组件」：
 * - 可以使用 useState / useEffect 等 React Hooks
 * - 可以绑定事件处理器（onClick 等）
 * - 打包到浏览器 JS bundle 并在浏览器中执行
 * - 代价是：不能直接访问后端数据库、不能使用 Node.js API、
 *   组件本身的 JS 代码会被发送到客户端（增加 bundle 体积）
 */
export default function Counter({ label, initial }: CounterProps) {
  /**
   * useState：客户端专属，维护组件内部的可变状态。
   * 服务端组件里调用它会直接报错，这也是我们需要 "use client" 的直接原因。
   */
  const [count, setCount] = useState(initial);

  return (
    <div className="demo-box">
      {/* 标签来自服务端 props，演示数据从服务端流向客户端组件 */}
      <p style={{ marginTop: 0, fontWeight: 600 }}>{label}</p>

      {/* 当前计数展示 */}
      <p style={{ fontSize: "2.5rem", margin: "12px 0", fontWeight: 700, letterSpacing: "0.02em" }}>
        {count}
      </p>

      {/* 操作按钮区 */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        {/* -1 按钮：onClick 只能在客户端组件里使用 */}
        <button
          className="btn"
          style={{ background: "#3a4a6b" }}
          onClick={() => setCount((c) => c - 1)}
        >
          − 1
        </button>

        {/* +1 按钮 */}
        <button
          className="btn"
          onClick={() => setCount((c) => c + 1)}
        >
          + 1
        </button>

        {/* 重置：把 count 还原为服务端传来的初始值 */}
        <button
          className="btn"
          style={{ background: "#2e3a29", color: "#8fdb70" }}
          onClick={() => setCount(initial)}
        >
          重置 ({initial})
        </button>
      </div>

      <p className="muted" style={{ marginBottom: 0, fontSize: "13px", marginTop: "14px" }}>
        初始值 <code>{initial}</code> 由服务端组件通过 props 传入，
        点击按钮后的状态变化完全在浏览器内完成，无需网络请求。
      </p>
    </div>
  );
}
