/**
 * 第 09 章页面：样式、元数据与中间件
 *
 * 路由：/（根路由，独立项目）
 * 文件：src/app/page.tsx
 *
 * 这是一个「服务端组件」（Server Component）——App Router 默认行为，无需任何标注。
 * 本页面演示三个核心主题：
 *   1. Next.js 中的多种样式方案（CSS Modules、全局 CSS、内联 style）
 *   2. Metadata API——静态与动态两种方式设置 <title> 和 <meta> 标签
 *   3. 中间件（Middleware）——请求拦截与重定向的原理和写法（示例代码，未实际启用）
 */

// ─── 导入类型 ────────────────────────────────────────────────────────────────
// Metadata 类型由 Next.js 提供，用于描述页面的元数据结构。
// 只 import type，不会增加运行时包体积。
import type { Metadata } from "next";

// ─── 导入 CSS Module ─────────────────────────────────────────────────────────
// CSS Module 的导入方式：用 `import styles from "./styles.module.css"`。
// `styles` 是一个普通 JS 对象，键是原始类名，值是经过哈希处理后的唯一类名。
// 例如 styles.gradientCard 实际上是 "gradientCard_a1b2c3__xxx" 这样的字符串。
// 这保证了每个模块的样式完全隔离，不会与其他文件或全局样式产生冲突。
import styles from "./styles.module.css";

// ─── 静态元数据导出 ──────────────────────────────────────────────────────────
// Next.js App Router 支持从任何 page.tsx 或 layout.tsx 导出一个 `metadata` 对象。
// 框架会自动把这个对象转换为 HTML <head> 里的 <title>、<meta> 等标签。
// 这是「静态元数据」——构建时就确定，适用于内容固定的页面。
// 浏览器标签页标题、搜索引擎抓取、社交媒体分享卡片都依赖这些信息。
//
// 注意：page.tsx 的 metadata 与 layout.tsx 的 metadata 会合并，
// 同名字段以 page.tsx 为准（覆盖）。这是 Next.js 的正常合并行为。
export const metadata: Metadata = {
  // 设置浏览器标签页的标题，以及搜索引擎结果页（SERP）显示的标题
  title: "第09章 · 样式与元数据",
  // meta description：搜索引擎摘要、社交分享卡片的描述文字（建议 120-160 字符）
  description:
    "学习 Next.js 15 中的 CSS Modules、全局样式、内联 style 等样式方案，掌握 Metadata API 控制 SEO 元数据，了解 middleware 中间件的请求拦截机制。",
  // openGraph：控制分享到微信、Twitter、Slack 等平台时的预览卡片
  openGraph: {
    title: "第09章 · 样式与元数据 | Next.js 15 教程",
    description: "CSS Modules 作用域隔离、Metadata API SEO 优化、Middleware 请求拦截一网打尽。",
    type: "article",
  },
};

// ─── 页面组件 ────────────────────────────────────────────────────────────────
export default function Chapter09Page() {
  return (
    <div>
      {/* ── 标题与简介 ──────────────────────────────────────────────────────── */}
      <h1>第 09 章 · 样式、元数据与中间件</h1>
      <p>
        本章涵盖 Next.js 应用开发中三个紧密相关的主题：
        如何用多种方式给组件添加样式（CSS Modules、全局 CSS、内联 style）；
        如何用 Metadata API 控制页面的 <code>{'<title>'}</code> 和 <code>{'<meta>'}</code> 标签以改善 SEO；
        以及中间件（Middleware）如何在请求到达路由之前进行拦截、重定向等处理。
      </p>

      {/* ════════════════════════════════════════════════════════════════════
          第一部分：样式方案
         ════════════════════════════════════════════════════════════════════ */}
      <h2>1. 样式方案全景</h2>
      <p>
        Next.js 对样式方案几乎没有限制，内置支持多种主流方式，
        可以根据项目需求自由选择或混用：
      </p>

      {/* 样式方案对比卡片 */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>四种主要样式方案</h3>

        {/* 1. 全局 CSS */}
        <section style={{ marginBottom: "20px" }}>
          <h4 style={{ margin: "0 0 6px" }}>
            <span className="tag">全局 CSS</span>&nbsp;&nbsp;globals.css
          </h4>
          <p style={{ margin: "0 0 6px" }}>
            在根布局（<code>layout.tsx</code>）中 <code>import "./globals.css"</code>，
            样式对所有页面和组件生效。适合放 CSS Reset、CSS 变量（颜色、字体）、
            以及少量全局工具类（如本项目的 <code>.card</code>、<code>.btn</code> 等）。
          </p>
          <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
            注意：全局 CSS 文件只能在布局或页面中导入，不能在普通服务端组件中随意导入。
            且只应有一个全局 CSS 入口，避免样式顺序不确定带来的问题。
          </p>
        </section>

        {/* 2. CSS Modules */}
        <section style={{ marginBottom: "20px" }}>
          <h4 style={{ margin: "0 0 6px" }}>
            <span className="tag">CSS Modules</span>&nbsp;&nbsp;*.module.css
          </h4>
          <p style={{ margin: "0 0 6px" }}>
            文件名以 <code>.module.css</code> 结尾，构建时类名自动加哈希（作用域隔离）。
            导入为 JS 对象，用 <code>className={"{styles.xxx}"}</code> 使用。
            是 Next.js 推荐的「组件级样式」方案——既有类型提示，又无冲突风险。
          </p>
          <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
            本页面的渐变卡片就是用 CSS Module 实现的，见下方演示。
          </p>
        </section>

        {/* 3. 内联 style */}
        <section style={{ marginBottom: "20px" }}>
          <h4 style={{ margin: "0 0 6px" }}>
            <span className="tag">内联 style</span>&nbsp;&nbsp;style={"{{}}"} 对象
          </h4>
          <p style={{ margin: "0 0 6px" }}>
            在 JSX 元素上直接写 <code>style={`{{ color: "red", fontSize: 14 }}`}</code>。
            属性名使用驼峰命名（<code>fontSize</code> 而非 <code>font-size</code>），
            数字值默认单位为 <code>px</code>。
          </p>
          <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
            适合动态计算出的样式值、一次性微调。不适合大量或复杂样式（可读性差、无法用伪类/媒体查询）。
          </p>
        </section>

        {/* 4. Tailwind / CSS-in-JS */}
        <section>
          <h4 style={{ margin: "0 0 6px" }}>
            <span className="tag">Tailwind CSS</span>&nbsp;&nbsp;/&nbsp;&nbsp;
            <span className="tag">CSS-in-JS</span>
          </h4>
          <p style={{ margin: "0 0 6px" }}>
            <strong>Tailwind CSS</strong>：原子化工具类库，Next.js 官方 CLI 创建项目时可选择集成。
            优点是开发极快、样式与组件高度内聚；缺点是类名冗长、需要学习一套新的命名体系。
          </p>
          <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
            <strong>CSS-in-JS</strong>（如 styled-components、Emotion）：在 JS/TS 文件中直接写样式。
            支持动态样式、主题系统，但在 App Router 的服务端组件中使用需要额外配置，
            部分库与 RSC 的兼容性尚不完善——初学阶段建议优先使用 CSS Modules。
          </p>
        </section>
      </div>

      {/* ── CSS Module 实际演示 ──────────────────────────────────────────────── */}
      <h3>CSS Module 演示</h3>
      <p>
        下面这张卡片使用了本目录下的 <code>styles.module.css</code> 中定义的三个类：
        <code>gradientCard</code>、<code>pill</code>、<code>highlight</code>。
        右键「检查元素」可以看到，它们的实际 class 名称带有哈希后缀。
      </p>

      {/*
       * 使用 CSS Module 的方式：className={styles.gradientCard}
       * `styles` 是从 "./styles.module.css" 导入的对象。
       * 在浏览器 DevTools 中，你会看到这个 div 的 class 类似：
       *   gradientCard_abc123__hash（具体格式因 Next.js 版本而异）
       */}
      <div className={styles.gradientCard}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
          {/* styles.pill：使用 CSS Module 的 .pill 类 */}
          <span className={styles.pill}>CSS Module · 作用域隔离</span>
          <span className={styles.pill}>自动哈希类名</span>
        </div>

        {/*
         * styles.highlight：渐变文字效果。
         * 注意：如果用全局 CSS 写同名 .highlight 类，不会产生任何冲突，
         * 因为 CSS Module 的类名已经被哈希处理成了唯一字符串。
         */}
        <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "10px" }}>
          这是用 <span className={styles.highlight}>CSS Module</span> 渲染的渐变卡片
        </div>

        <p style={{ margin: "0 0 10px", color: "#9aa4b2", fontSize: "14px" }}>
          这张卡片的样式来自 <code>styles.module.css</code>，而非全局样式。
          即使全局或其他页面有同名的类，也绝不会干扰这里的渲染效果。
        </p>

        <p style={{ margin: 0, fontSize: "13px", color: "#6ea8fe" }}>
          打开浏览器 DevTools → 选中此卡片 → 查看 class 属性中的哈希后缀
        </p>
      </div>

      {/* ── 内联 style 演示 ──────────────────────────────────────────────────── */}
      <h3>内联 style 演示</h3>
      <p>
        内联 style 适合处理动态值或临时调整，无需新建 CSS 类：
      </p>

      {/*
       * 内联 style 对象演示。
       * 注意 JSX 中 style 接受的是一个 JS 对象，不是 CSS 字符串：
       *   - 属性名使用驼峰命名（background 而非 background-color）
       *   - 字符串值需要引号
       *   - 数字值默认追加 px（fontSize: 14 → font-size: 14px）
       */}
      <div
        style={{
          background: "linear-gradient(90deg, rgba(34,40,60,1), rgba(20,24,40,1))",
          border: "1px dashed rgba(110,168,254,0.4)",
          borderRadius: "10px",
          padding: "20px 24px",
          margin: "12px 0 24px",
          fontSize: "14px",
        }}
      >
        <p style={{ margin: "0 0 8px", fontWeight: 600 }}>内联 style 示例块</p>
        <p style={{ margin: 0, color: "#9aa4b2" }}>
          这个 div 的所有样式都通过 <code>style={"{{}}"}</code> 属性直接写在 JSX 里。
          适合一次性使用或动态计算出的样式值，
          但大量样式时会让 JSX 变得臃肿——此时请改用 CSS Module。
        </p>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          第二部分：Metadata API
         ════════════════════════════════════════════════════════════════════ */}
      <h2>2. Metadata API</h2>
      <p>
        Next.js App Router 提供了两种方式来设置页面的元数据（<code>{'<title>'}</code>、
        <code>{'<meta>'}</code>、<code>{'<link rel="icon">'}</code> 等 HTML <code>{'<head>'}</code> 标签内的内容）。
        这些标签对 SEO、社交媒体分享卡片以及浏览器行为至关重要。
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>方式一：静态 metadata 对象（本页正在使用）</h3>
        <p>
          从 <code>page.tsx</code> 或 <code>layout.tsx</code> 导出一个名为 <code>metadata</code> 的常量，
          类型为 <code>Metadata</code>（从 <code>next</code> 包导入）。
          Next.js 会在渲染时自动把这个对象的字段转换为对应的 HTML 标签。
        </p>

        <pre>
          <code>{`// page.tsx 或 layout.tsx 顶部
import type { Metadata } from "next";

// 导出名称必须固定为 "metadata"，Next.js 通过名称识别它
export const metadata: Metadata = {
  // 设置 <title> 标签的内容
  title: "第09章 · 样式与元数据",

  // 设置 <meta name="description" content="...">
  description: "学习 CSS Modules、Metadata API 和 Middleware...",

  // openGraph：控制社交媒体分享卡片（微信、Twitter、Slack 等）
  openGraph: {
    title: "第09章 · 样式与元数据 | Next.js 15 教程",
    description: "CSS Modules、Metadata API、Middleware 一网打尽。",
    type: "article",
    // images: [{ url: "/og-cover.png", width: 1200, height: 630 }],
  },

  // icons：网站图标（浏览器标签页左侧的小图标）
  // icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" },

  // robots：控制搜索引擎爬虫行为
  // robots: { index: true, follow: true },
};`}</code>
        </pre>

        <p className="muted" style={{ fontSize: "13px", margin: "0" }}>
          本页面文件顶部已经导出了 metadata 对象——打开浏览器开发者工具，
          切换到「Elements」标签，可以在 <code>{'<head>'}</code> 中看到自动生成的 <code>{'<title>'}</code> 和 <code>{'<meta>'}</code> 标签。
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>方式二：generateMetadata（动态元数据）</h3>
        <p>
          当元数据需要根据动态参数（如文章 ID）或异步数据（数据库/接口）来决定时，
          使用 <code>generateMetadata</code> 异步函数代替静态对象。
        </p>

        <p>
          以下是示例代码（本页面无需动态元数据，仅作演示）：
        </p>

        <pre>
          <code>{`// src/app/blog/[slug]/page.tsx
import type { Metadata } from "next";

// generateMetadata 是 Next.js 约定的特殊函数名，必须 export
// 它接收与页面相同的 props（params、searchParams）
export async function generateMetadata(
  // Next.js 15：params 是 Promise，必须 await
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;

  // 可以在这里发起数据请求，Next.js 会自动去重（deduplication）：
  // 与页面组件中相同 URL 的 fetch 只会发一次请求
  const post = await fetch(\`/api/posts/\${slug}\`).then((r) => r.json());

  return {
    title: post.title,                         // 动态标题
    description: post.summary,                // 动态描述
    openGraph: {
      title: post.title,
      images: [{ url: post.coverImage }],     // 动态 OG 图片
    },
  };
}

// 页面组件正常写，generateMetadata 与它并列导出
export default async function BlogPost(
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const post = await fetch(\`/api/posts/\${slug}\`).then((r) => r.json());
  return <article><h1>{post.title}</h1></article>;
}`}</code>
        </pre>

        <p className="muted" style={{ fontSize: "13px", margin: "0" }}>
          <strong>关键优势：</strong>generateMetadata 中的 fetch 请求与页面组件中的 fetch 请求
          会被 Next.js 自动去重——即使两处写了相同的 URL，实际网络请求只发生一次，不会浪费资源。
        </p>
      </div>

      {/* Metadata 常用字段速查 */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Metadata 常用字段速查</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #232a36" }}>
                <th style={{ textAlign: "left", padding: "6px 16px 10px 0", color: "#9aa4b2", whiteSpace: "nowrap" }}>字段</th>
                <th style={{ textAlign: "left", padding: "6px 0 10px", color: "#9aa4b2" }}>生成的 HTML 标签 / 说明</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["title", "<title>页面标题</title>  —— 也可以是对象 { template, default }"],
                ["description", '<meta name="description" content="...">  —— SEO 摘要'],
                ["openGraph.title", '<meta property="og:title" content="...">  —— 社交分享标题'],
                ["openGraph.images", '<meta property="og:image" content="...">  —— 分享缩略图'],
                ["icons.icon", '<link rel="icon" href="...">  —— 网站图标'],
                ["icons.apple", '<link rel="apple-touch-icon" href="...">  —— iOS 主屏图标'],
                ["robots", '<meta name="robots" content="index,follow">  —— 爬虫指令'],
                ["keywords", '<meta name="keywords" content="...">  —— 关键词（现代搜索引擎权重极低）'],
                ["alternates.canonical", '<link rel="canonical" href="...">  —— 规范化 URL，避免重复内容'],
              ].map(([field, desc]) => (
                <tr key={field} style={{ borderBottom: "1px solid #1c2230" }}>
                  <td style={{ padding: "8px 16px 8px 0", whiteSpace: "nowrap" }}>
                    <code>{field}</code>
                  </td>
                  <td style={{ padding: "8px 0", color: "#9aa4b2" }}>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          第三部分：中间件
         ════════════════════════════════════════════════════════════════════ */}
      <h2>3. 中间件（Middleware）</h2>

      <div className="demo-box">
        <p style={{ margin: "0 0 8px", fontWeight: 600, color: "#fbbf24" }}>
          ⚠️ 本教程不实际创建 middleware.ts 文件
        </p>
        <p style={{ margin: 0, fontSize: "14px", color: "#9aa4b2" }}>
          <code>middleware.ts</code> 放在项目根目录（与 <code>src/</code> 平级或 <code>src/</code> 内部），
          会对<strong>整个项目的所有请求</strong>生效。
          为了避免影响本教程的其他章节页面，本章只用文字和代码块讲解，不实际启用中间件。
        </p>
      </div>

      <p>
        中间件是一个在<strong>请求到达路由、页面或 API 处理器之前</strong>运行的函数。
        它运行在 Next.js 的「Edge Runtime」上（基于 V8 的轻量运行时，不是完整的 Node.js），
        延迟极低，适合做：
      </p>

      <ul>
        <li><strong>身份验证 / 鉴权</strong>——检查 Session/JWT Cookie，未登录则重定向到登录页</li>
        <li><strong>条件重定向</strong>——根据地区、设备、Feature Flag 等跳转到不同 URL</li>
        <li><strong>URL 重写（Rewrite）</strong>——修改请求目标而不改变浏览器地址栏的 URL</li>
        <li><strong>A/B 测试</strong>——随机分流用户到不同版本的页面</li>
        <li><strong>国际化（i18n）</strong>——根据 Accept-Language 或 Cookie 跳转到对应语言前缀的路由</li>
        <li><strong>添加响应头</strong>——注入安全头（CSP、X-Frame-Options 等）</li>
      </ul>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>middleware.ts 基本结构与 matcher 配置</h3>
        <p className="muted" style={{ fontSize: "13px", marginTop: 0 }}>
          文件位置：<code>src/middleware.ts</code>（与 <code>src/app/</code> 平级）或项目根目录的 <code>middleware.ts</code>。
        </p>

        <pre>
          <code>{`// src/middleware.ts
// ⚠️ 这是示例代码，本教程项目中没有实际创建此文件

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// middleware 函数：对每个匹配的请求调用一次
// 参数 request：包含 URL、headers、cookies 等请求信息
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 示例 1：根据 Cookie 进行身份验证重定向 ──────────────────
  // 获取名为 "session" 的 Cookie 值
  const sessionCookie = request.cookies.get("session")?.value;

  // 如果访问 /dashboard 开头的路径但没有登录 Cookie，重定向到登录页
  if (pathname.startsWith("/dashboard") && !sessionCookie) {
    // NextResponse.redirect：返回一个 302 重定向响应
    // request.nextUrl.clone() 复制当前 URL 以便修改
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    // 可以附加 callbackUrl 参数，登录后跳转回原页面
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── 示例 2：URL 重写（Rewrite）——不改变浏览器地址栏 ────────
  // 用户访问 /old-path，但实际渲染 /new-path 的内容
  if (pathname === "/old-path") {
    const newUrl = request.nextUrl.clone();
    newUrl.pathname = "/new-path";
    return NextResponse.rewrite(newUrl);
  }

  // ── 示例 3：添加自定义响应头 ─────────────────────────────────
  // NextResponse.next() 继续正常处理请求，可以修改请求/响应头
  const response = NextResponse.next();
  response.headers.set("X-Custom-Header", "hello-from-middleware");
  return response;
}

// ── matcher 配置：指定中间件作用的路径范围 ──────────────────────────────────
// 没有 matcher 时，中间件对所有请求（包括静态文件、图片等）都运行，性能较差。
// 强烈建议配置 matcher 缩小范围：
export const config = {
  matcher: [
    // 匹配 /dashboard 及其所有子路径
    "/dashboard/:path*",

    // 匹配 /api 开头的路径（排除 Next.js 内部路径）
    "/api/:path*",

    // 更精细的写法：排除静态资源和 Next.js 内部文件
    // "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};`}</code>
        </pre>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>中间件的三种响应方式</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #232a36" }}>
                <th style={{ textAlign: "left", padding: "6px 16px 10px 0", color: "#9aa4b2" }}>方法</th>
                <th style={{ textAlign: "left", padding: "6px 0 10px", color: "#9aa4b2" }}>行为说明</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["NextResponse.next()", "继续正常请求流程，可选择性地修改请求头或响应头"],
                ["NextResponse.redirect(url)", "返回 302/307 重定向，浏览器地址栏变为新 URL"],
                ["NextResponse.rewrite(url)", "内部重写请求目标，浏览器地址栏保持不变"],
                ["new NextResponse(body, opts)", "直接返回自定义响应（如 JSON 错误信息）"],
              ].map(([method, desc]) => (
                <tr key={method as string} style={{ borderBottom: "1px solid #1c2230" }}>
                  <td style={{ padding: "8px 16px 8px 0", whiteSpace: "nowrap" }}>
                    <code>{method as string}</code>
                  </td>
                  <td style={{ padding: "8px 0", color: "#9aa4b2" }}>{desc as string}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Edge Runtime 的限制（重要）</h3>
        <p style={{ marginTop: 0, color: "#9aa4b2", fontSize: "14px" }}>
          中间件运行在 Edge Runtime，不是完整的 Node.js 环境，以下 API 不可用：
        </p>
        <ul style={{ fontSize: "14px", color: "#9aa4b2" }}>
          <li>
            <strong>不能用 Node.js 内置模块</strong>——如 <code>fs</code>（文件系统）、
            <code>path</code>、<code>crypto</code>（部分 API 可用）等
          </li>
          <li>
            <strong>不能直接连接数据库</strong>——如 Prisma ORM、原生 PostgreSQL 驱动等需要 TCP 连接的库
          </li>
          <li>
            <strong>包体积限制</strong>——Edge 函数有严格的体积上限（Vercel 默认 1MB），
            不能引入大型 npm 包
          </li>
          <li>
            <strong>替代方案</strong>——需要数据库或复杂逻辑时，在中间件里只做轻量的 JWT/Cookie 验证，
            把重逻辑放到 Route Handler 或 Server Action 中
          </li>
        </ul>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          本章小结
         ════════════════════════════════════════════════════════════════════ */}
      <div className="card" style={{ marginTop: "32px" }}>
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul style={{ marginBottom: 0 }}>
          <li>
            <strong>全局 CSS</strong>——在根 <code>layout.tsx</code> 中导入，全站生效；
            适合 CSS 变量、Reset 和少量全局工具类。
          </li>
          <li>
            <strong>CSS Modules</strong>（<code>*.module.css</code>）——类名自动哈希，作用域完全隔离；
            是 Next.js 推荐的组件级样式方案，开箱即用、无冲突。
          </li>
          <li>
            <strong>内联 style</strong>——JSX 中传入对象，属性名用驼峰；
            适合动态值或一次性微调，不适合复杂样式。
          </li>
          <li>
            <strong>Tailwind / CSS-in-JS</strong>——功能更强大，但有额外依赖和学习成本；
            App Router 中 CSS-in-JS 需要额外适配 RSC。
          </li>
          <li>
            <strong>静态 metadata 对象</strong>——从 page/layout 导出 <code>export const metadata</code>，
            框架自动生成 <code>{'<title>'}</code>、<code>{'<meta>'}</code> 等标签，零运行时开销。
          </li>
          <li>
            <strong>generateMetadata 函数</strong>——异步生成元数据，可根据路由参数或接口返回值动态设置；
            内部 fetch 请求与页面组件的同 URL 请求自动去重。
          </li>
          <li>
            <strong>中间件（Middleware）</strong>——在请求到达路由前运行于 Edge Runtime；
            用 <code>matcher</code> 限制作用范围；三种响应方式（next/redirect/rewrite）；
            不可用完整 Node.js API，不能直连数据库。
          </li>
        </ul>
      </div>
    </div>
  );
}
