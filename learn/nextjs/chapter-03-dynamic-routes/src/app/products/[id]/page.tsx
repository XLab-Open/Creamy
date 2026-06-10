/**
 * 动态路由页：产品详情
 *
 * 路由：/products/[id]
 * 文件：src/app/products/[id]/page.tsx
 *
 * ────────────────────────────────────────────────────────────
 * 为什么 params 是 Promise？（Next.js 15 重大变化）
 * ────────────────────────────────────────────────────────────
 * 在 Next.js 14 及更早版本中，params 是一个普通对象，可以直接读取：
 *   const { id } = params;  // 旧写法，Next 14
 *
 * 从 Next.js 15 开始，框架将 params 改为 Promise，以便支持未来的
 * 并发特性和流式渲染优化。因此必须：
 *   1. 将页面组件声明为 async function
 *   2. 在函数体内 await params，再读取字段
 *
 *   export default async function Page({
 *     params,
 *   }: {
 *     params: Promise<{ id: string }>;  // ← 类型是 Promise
 *   }) {
 *     const { id } = await params;       // ← 必须 await
 *     ...
 *   }
 *
 * 如果不 await 而直接访问 params.id，TypeScript 会报错，
 * 且运行时会得到 undefined（Promise 对象没有 .id 属性）。
 * ────────────────────────────────────────────────────────────
 */

import Link from "next/link";

// ── 模拟产品数据库 ────────────────────────────────────────────────
// 实际项目中这里会是数据库查询或 API 调用。
// 用本地数组来演示「按 id 查找」的逻辑，不引入额外依赖。
type Product = {
  id: string;
  name: string;
  price: number;
  description: string;
  category: string;
};

const PRODUCTS: Product[] = [
  {
    id: "1",
    name: "Next.js 入门手册",
    price: 39,
    description: "从零开始学习 Next.js App Router，包含大量实战示例。",
    category: "书籍",
  },
  {
    id: "2",
    name: "TypeScript 实战课",
    price: 99,
    description: "系统学习 TypeScript 类型系统，让代码更安全、更易维护。",
    category: "视频课程",
  },
  {
    id: "3",
    name: "React 19 新特性解析",
    price: 59,
    description: "深入 React 19 的并发特性、Server Components 与 Actions。",
    category: "视频课程",
  },
];

// ── generateStaticParams ──────────────────────────────────────────
/**
 * generateStaticParams 告诉 Next.js 构建时需要预渲染哪些路径。
 *
 * 作用：
 *   - 在 `next build` 阶段，Next.js 会调用这个函数，获取所有参数组合，
 *     并为每个组合生成一份静态 HTML 文件（SSG）。
 *   - 用户请求这些页面时，直接返回预生成的 HTML，无需服务端运算，
 *     响应极快（CDN 可缓存）。
 *   - 对于没在这里列出的 id（如 id=999），Next.js 会在运行时动态渲染
 *     （若设置了 dynamicParams = true，默认值；设为 false 则返回 404）。
 *
 * 返回值：参数对象数组，键名必须与文件夹名中方括号内的名字一致（这里是 "id"）。
 */
export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }, { id: "3" }];
  // 等价于：PRODUCTS.map((p) => ({ id: p.id }))
}

// ── 页面组件 ──────────────────────────────────────────────────────
/**
 * 页面组件必须是 async function，因为要 await params。
 *
 * 参数类型说明：
 *   params: Promise<{ id: string }>
 *     - 外层 Promise<...>   → Next.js 15 约定，params 是 Promise
 *     - 内层 { id: string } → [id] 文件夹名决定了字段名叫 "id"，值总是 string
 */
export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // ── 1. await params，取出动态段的值 ─────────────────────────────
  // 这是 Next.js 15 必须的步骤。await 之后才是真正的 { id: string } 对象。
  const { id } = await params;

  // ── 2. 根据 id 查找产品 ──────────────────────────────────────────
  // 实际项目中这里应该调用数据库或 API，例如：
  //   const product = await db.products.findUnique({ where: { id } });
  const product = PRODUCTS.find((p) => p.id === id);

  return (
    <div>
      {/* 返回首页 */}
      <div style={{ marginBottom: "20px" }}>
        <Link
          href="/"
          style={{ color: "#6ea8fe", fontSize: "14px" }}
        >
          ← 返回第 03 章概览
        </Link>
      </div>

      <h1>第 03 章 · 动态路由与路由组</h1>
      <p className="muted">
        当前页面由动态路由 <code>/products/[id]</code> 渲染，
        URL 中的 <code>{id}</code> 被解析为参数 <code>id</code>。
      </p>

      {/* ── 参数解析演示 ──────────────────────────────────────────── */}
      <div className="card">
        <h2>参数解析结果</h2>
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: "14px",
          }}
        >
          <tbody>
            <tr>
              <td
                style={{
                  padding: "8px 12px",
                  color: "#adb5bd",
                  width: "160px",
                }}
              >
                当前 URL
              </td>
              <td style={{ padding: "8px 12px" }}>
                <code>/products/{id}</code>
              </td>
            </tr>
            <tr>
              <td style={{ padding: "8px 12px", color: "#adb5bd" }}>
                动态段名
              </td>
              <td style={{ padding: "8px 12px" }}>
                <code>[id]</code>（由文件夹名决定）
              </td>
            </tr>
            <tr>
              <td style={{ padding: "8px 12px", color: "#adb5bd" }}>
                解析到的值
              </td>
              <td style={{ padding: "8px 12px" }}>
                <span className="tag">{id}</span>（类型：string）
              </td>
            </tr>
            <tr>
              <td style={{ padding: "8px 12px", color: "#adb5bd" }}>
                params 类型
              </td>
              <td style={{ padding: "8px 12px" }}>
                <code>Promise{"<{ id: string }>"}</code>（Next.js 15 起）
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── 产品详情 ──────────────────────────────────────────────── */}
      {product ? (
        // ─ 找到产品：展示详情 ─────────────────────────────────────
        <div className="card">
          <h2>
            产品详情{" "}
            <span className="tag" style={{ fontSize: "14px" }}>
              #{product.id}
            </span>
          </h2>

          <h3 style={{ marginTop: "8px", marginBottom: "4px" }}>
            {product.name}
          </h3>
          <p className="muted" style={{ marginBottom: "12px" }}>
            {product.description}
          </p>

          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <span className="tag">{product.category}</span>
            <span style={{ color: "#6ea8fe", fontSize: "20px", fontWeight: 600 }}>
              ¥{product.price}
            </span>
          </div>

          <p
            className="muted"
            style={{ marginTop: "16px", fontSize: "12px" }}
          >
            该产品数据来自本地数组（模拟数据库）。
            id 1、2、3 已通过 generateStaticParams 在构建时预渲染。
          </p>
        </div>
      ) : (
        // ─ 找不到产品：友好提示 ──────────────────────────────────
        <div className="card">
          <h2>找不到产品</h2>
          <p>
            ID 为 <span className="tag">{id}</span> 的产品不存在于数据库中。
          </p>
          <p className="muted" style={{ fontSize: "13px" }}>
            在实际项目中，这里通常会调用 Next.js 内置的{" "}
            <code>notFound()</code> 函数来渲染 404 页面（见第 07 章）。
          </p>
          <div style={{ marginTop: "16px", display: "flex", gap: "10px" }}>
            <Link className="btn" href="/products/1">
              查看产品 #1
            </Link>
            <Link className="btn" href="/products/2">
              查看产品 #2
            </Link>
          </div>
        </div>
      )}

      {/* ── generateStaticParams 说明 ─────────────────────────────── */}
      <div className="card">
        <h2>generateStaticParams 工作原理</h2>
        <p>
          本页面导出了 <code>generateStaticParams</code>，返回三个产品 id：
        </p>
        <pre
          style={{
            background: "rgba(0,0,0,0.3)",
            borderRadius: "6px",
            padding: "12px",
            fontSize: "13px",
            overflowX: "auto",
          }}
        >{`export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }, { id: "3" }];
}
// 构建期 Next.js 会预生成：
//   /products/1  → 静态 HTML
//   /products/2  → 静态 HTML
//   /products/3  → 静态 HTML`}</pre>
        <p className="muted" style={{ fontSize: "13px" }}>
          你正在访问的{" "}
          <code>/products/{id}</code>：
          {["1", "2", "3"].includes(id)
            ? " 已在构建期预渲染（SSG）。"
            : " 不在预渲染列表中，属于运行时动态渲染（SSR）。"}
        </p>
      </div>

      {/* ── 快速跳转 ──────────────────────────────────────────────── */}
      <div className="card">
        <h2>快速跳转到其他产品</h2>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {PRODUCTS.map((p) => (
            <Link
              key={p.id}
              className="btn"
              href={`/products/${p.id}`}
            >
              产品 #{p.id}：{p.name}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
