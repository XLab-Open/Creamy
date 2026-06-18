# 第 09 章笔记：样式、元数据与中间件

## 一、Next.js 样式方案全景

### 1.1 全局 CSS

全局 CSS 文件（如 `globals.css`）在根布局 `layout.tsx` 中通过 `import "./globals.css"` 导入，对整个应用的所有页面和组件生效。这是放置 CSS 重置规则（Reset）、CSS 自定义属性（变量）以及全局工具类的最佳位置。

**使用约定：**
- 整个项目通常只有一个全局 CSS 入口，避免因多个全局文件的加载顺序不确定而产生样式冲突。
- 全局 CSS 中的类名是「裸名」，任何组件都可以使用 `className="card"` 直接引用，但也正因如此，类名一旦重复就会互相干扰。
- 不要在普通的客户端组件或服务端组件中随意 import 全局 CSS——Next.js 规定只有 layout 和 page 文件可以引入 CSS 文件。

**适合放的内容：**CSS 变量（颜色、字体、间距）、`*` 通配符重置、`body`/`html` 基础样式、少量高频工具类（`.card`、`.btn`、`.muted` 等）。

### 1.2 CSS Modules：作用域隔离的核心机制

CSS Modules 是 Next.js 内置支持的组件级样式方案，**文件名必须以 `.module.css` 结尾**。

**工作原理（三步）：**
1. **编译阶段**：构建工具（Next.js 内部使用 Turbopack 或 Webpack）扫描 `.module.css` 文件，为每个类名生成一个唯一的哈希字符串，例如 `.gradientCard` → `gradientCard_a1b2c3__hashXXX`。
2. **模块导出**：生成一个 JavaScript 对象，结构如 `{ gradientCard: "gradientCard_a1b2c3__hashXXX", pill: "pill_d4e5f6__hashYYY" }`。
3. **运行时使用**：组件中写 `className={styles.gradientCard}`，实际渲染的 `class` 属性是哈希后的唯一字符串。

**使用方式：**

```tsx
// 1. 导入（返回一个普通 JS 对象）
import styles from "./Button.module.css";

// 2. 在 JSX 中使用
function Button() {
  return <button className={styles.btn}>点击</button>;
}

// 3. 组合多个 CSS Module 类（用模板字符串或 clsx 库）
<div className={`${styles.card} ${styles.active}`}>...</div>
```

**关键优势：**
- **零冲突**：即使两个不同文件都定义了 `.title` 类，它们的哈希后缀不同，不会互相干扰。
- **可维护**：可以使用语义化的短类名（`.title`、`.wrapper`），无需 BEM 命名约定。
- **类型安全**：配合 TypeScript 和 IDE 插件，`styles.xxx` 有自动补全，拼写错误会报错。
- **零运行时开销**：类名在编译期确定，不像 CSS-in-JS 那样在运行时注入样式。

**注意事项：**
- CSS Module 文件中无法使用全局类选择器（如 `.card`），需要用 `:global(.card)` 语法才能引用全局类。
- 不支持 CSS 变量的自动作用域——CSS 变量（`--color-primary`）依然是全局的，但通常这正是我们想要的。

### 1.3 内联 style

内联 `style` 在 JSX 中以对象形式传入：

```tsx
<div style={{
  backgroundColor: "#141821",  // 驼峰命名，不是 background-color
  padding: "20px 24px",        // 字符串值需要引号和单位
  fontSize: 14,                // 数字值自动追加 px
  borderRadius: 8,
}}>
  内容
</div>
```

**适用场景：**
- 样式值是运行时动态计算出来的（如根据 props、state 变化的宽度/颜色）。
- 一次性微调，不值得新建 CSS 类。

**不适用场景：**
- 大量样式（JSX 可读性急剧下降）。
- 需要伪类（`:hover`、`:focus`）或媒体查询（内联 style 不支持）。
- 需要动画关键帧（`@keyframes`）。

### 1.4 Tailwind CSS 与 CSS-in-JS 的取舍

**Tailwind CSS：**
- 原子化工具类库，如 `className="flex items-center gap-4 rounded-lg bg-blue-500"`。
- 优点：开发极快，样式与结构高度内聚，无需在 CSS 和 JSX 文件间切换，体积经 PurgeCSS 优化后极小。
- 缺点：类名冗长，有一定学习成本，对「语义化」样式类名的强迫症患者不友好。
- **Next.js 官方 CLI 创建项目时可选择集成**，配置文件为 `tailwind.config.ts`。

**CSS-in-JS（styled-components、Emotion 等）：**
- 在 JS/TS 文件中用模板字符串或对象写 CSS，支持完整的动态样式（基于 props）和主题系统。
- **App Router 兼容性问题**：CSS-in-JS 库通常在运行时注入样式，但 React Server Components（RSC）不在客户端运行，无法使用运行时注入。目前大多数 CSS-in-JS 库需要额外的服务端配置，且部分功能受限。
- **初学阶段建议优先使用 CSS Modules**——功能足够、无额外依赖、与 RSC 完全兼容。

---

## 二、Metadata API

### 2.1 元数据的重要性

HTML `<head>` 中的元数据标签对以下场景至关重要：
- **SEO（搜索引擎优化）**：`<title>` 和 `<meta name="description">` 是搜索引擎排名的重要信号，也是搜索结果页（SERP）展示给用户的标题和摘要。
- **社交媒体分享**：Open Graph（`og:`）标签控制分享到微信、Twitter/X、Slack 等平台时的预览卡片（标题、描述、缩略图）。
- **浏览器行为**：图标（favicon）、主题色、viewport 配置等。

### 2.2 静态 metadata 对象

从 `page.tsx` 或 `layout.tsx` 导出一个名为 `metadata` 的常量（名称固定，Next.js 通过名称识别）：

```tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  // <title> 标签——也可以是对象，支持模板
  title: {
    template: "%s | 我的网站",  // %s 会被子页面的 title 替换
    default: "我的网站",         // 没有子页面 title 时使用
  },
  description: "页面描述，建议 120-160 字符以内",

  // Open Graph
  openGraph: {
    title: "OG 标题（可与 <title> 不同）",
    description: "OG 描述",
    type: "article",           // 'website' | 'article' | 'book' 等
    images: [{
      url: "/og-cover.png",
      width: 1200,
      height: 630,
      alt: "封面图描述",
    }],
  },

  // 网站图标
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon-16x16.png",
    apple: "/apple-touch-icon.png",  // iOS 主屏添加快捷方式时使用
  },

  // 规范化 URL，避免重复内容惩罚
  alternates: {
    canonical: "https://example.com/this-page",
  },

  // 爬虫指令
  robots: {
    index: true,    // 允许索引
    follow: true,   // 允许跟随链接
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
    },
  },
};
```

**继承与覆盖：**`layout.tsx` 中的 metadata 是父级默认值，`page.tsx` 中的同名字段会覆盖它。这让你可以在根 layout 设置全站通用的 metadata（如 `icons`、`openGraph.images`），在各页面只覆盖 `title` 和 `description`。

### 2.3 generateMetadata 动态元数据

当元数据需要依赖动态路由参数或异步数据时，用 `generateMetadata` 函数替代静态对象：

```tsx
import type { Metadata } from "next";

// 函数签名与页面组件相同，接收 params 和 searchParams
export async function generateMetadata(
  { params, searchParams }: {
    params: Promise<{ slug: string }>;
    searchParams: Promise<{ q?: string }>;
  }
): Promise<Metadata> {
  const { slug } = await params;
  // fetch 请求会被 Next.js 自动去重——与页面组件中相同 URL 的请求只发一次
  const post = await fetch(`https://api.example.com/posts/${slug}`).then(r => r.json());

  return {
    title: post.title,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      images: [post.coverImage],
    },
  };
}
```

**注意（Next.js 15）**：`params` 和 `searchParams` 都是 Promise，必须 `await` 后才能使用。

### 2.4 常用字段对照表

| 字段 | 生成的 HTML |
|------|-------------|
| `title` | `<title>...</title>` |
| `description` | `<meta name="description" content="...">` |
| `openGraph.title` | `<meta property="og:title" content="...">` |
| `openGraph.description` | `<meta property="og:description" content="...">` |
| `openGraph.images[0].url` | `<meta property="og:image" content="...">` |
| `twitter.card` | `<meta name="twitter:card" content="...">` |
| `icons.icon` | `<link rel="icon" href="...">` |
| `alternates.canonical` | `<link rel="canonical" href="...">` |
| `robots.index` | `<meta name="robots" content="index,...">` |

---

## 三、中间件（Middleware）

### 3.1 什么是中间件

`middleware.ts`（或 `middleware.js`）是一个放在项目根目录（或 `src/` 目录下）的特殊文件。每当有请求进来时，Next.js 会在路由处理器（`page.tsx`、`layout.tsx`、`route.ts`）执行之前，先调用中间件函数。

**执行顺序：**
```
客户端请求
    ↓
middleware（中间件）← 本章重点
    ↓
Next.js 路由匹配
    ↓
layout.tsx → page.tsx（或 route.ts）
```

### 3.2 基本结构

```ts
// src/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // request.nextUrl：当前请求的 URL 对象
  // request.cookies：读取 Cookie
  // request.headers：读取请求头
  // request.geo：地理位置信息（部分托管平台支持）
  // request.ip：客户端 IP

  return NextResponse.next(); // 继续正常处理
}

// matcher 配置（关键！）
export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/:path*",
    // 排除静态文件和 Next.js 内部路径的通用写法：
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
```

### 3.3 matcher 配置详解

`matcher` 是一个路径模式数组，决定中间件对哪些请求生效：

```ts
export const config = {
  matcher: [
    // 精确匹配单个路径
    "/about",

    // 匹配 /blog 及其所有子路径（:path* 匹配零个或多个段）
    "/blog/:path*",

    // 正则表达式：排除以 _next、api 开头的路径
    "/((?!_next|api).*)",

    // 也支持对象形式，支持更多选项
    {
      source: "/admin/:path*",
      missing: [
        // 只在没有这个 header 时才应用（避免 bot 请求触发）
        { type: "header", key: "next-router-prefetch" },
      ],
    },
  ],
};
```

**为什么必须配置 matcher？**
不配置时，中间件对包括静态图片、`_next/static` 文件、favicon 在内的所有请求都运行，造成不必要的性能损耗。

### 3.4 三种响应方式

**1. NextResponse.next()** — 放行并可选修改头：
```ts
const response = NextResponse.next();
response.headers.set("X-Custom-Header", "value");
response.cookies.set("visited", "true");
return response;
```

**2. NextResponse.redirect()** — 重定向（浏览器地址栏变化）：
```ts
// 用 request.nextUrl.clone() 克隆当前 URL 再修改，避免构造绝对 URL
const url = request.nextUrl.clone();
url.pathname = "/login";
url.searchParams.set("callbackUrl", request.nextUrl.pathname);
return NextResponse.redirect(url, { status: 307 }); // 307 保留 HTTP 方法
```

**3. NextResponse.rewrite()** — 重写（地址栏不变，实际渲染不同内容）：
```ts
// 用户看到的 URL 仍是 /old-page，但实际渲染的是 /new-page
const url = request.nextUrl.clone();
url.pathname = "/new-page";
return NextResponse.rewrite(url);
```

### 3.5 Edge Runtime 的限制

中间件运行在 **Edge Runtime**，这是一个基于 V8（非完整 Node.js）的轻量运行时：

| 可以用 | 不能用 |
|--------|--------|
| Web API（fetch、Request、Response、URL 等）| Node.js 内置模块（fs、path、net 等）|
| `crypto.subtle`（Web Crypto API）| 数据库驱动（Prisma、pg、mysql2 等）|
| Next.js 的 NextRequest/NextResponse | 需要 TCP 连接的 npm 包 |
| 轻量 JWT 验证库（如 jose）| 体积超过 1MB 的 npm 包（Vercel 限制）|

**解决方案**：把需要数据库或复杂 Node.js 操作的逻辑放在 `route.ts`（Route Handler）或 Server Action 中，中间件只做轻量的 Cookie/JWT 检查和路由判断。

### 3.6 典型用途：JWT 鉴权示例

```ts
// src/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// jose 是一个支持 Edge Runtime 的轻量 JWT 库
// import { jwtVerify } from "jose";

const PROTECTED_PATHS = ["/dashboard", "/profile", "/settings"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 检查是否是需要保护的路径
  const isProtected = PROTECTED_PATHS.some(p => pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  // 读取 Cookie 中的 token
  const token = request.cookies.get("auth-token")?.value;

  if (!token) {
    // 未登录：重定向到登录页，附带原始路径
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // 如果需要验证 JWT 签名，使用 jose 的 jwtVerify（支持 Edge Runtime）
  // 这里简化为只检查 token 是否存在
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/auth).*)"],
};
```

---

## 四、常见坑

### 4.1 样式相关

**坑 1：CSS Module 类名大小写**
CSS Module 支持驼峰类名（`.gradientCard`）和短横线类名（`.gradient-card`）。若使用短横线，JS 对象中需要方括号访问：`styles["gradient-card"]`。推荐统一用驼峰命名。

**坑 2：`:global` 选择器**
在 CSS Module 中若需要覆盖全局类（如第三方组件的类名），需要用 `:global`：
```css
/* 在 .module.css 文件中覆盖全局类 .ant-btn */
.wrapper :global(.ant-btn) {
  border-radius: 8px;
}
```

**坑 3：内联 style 不支持伪类**
`style={{ ":hover": { color: "red" } }}` 这种写法**不起作用**。伪类和媒体查询只能在 CSS 文件（全局或 Module）中写。

### 4.2 Metadata 相关

**坑 4：metadata 必须从服务端组件导出**
`metadata` 和 `generateMetadata` 只能从 Server Component（`page.tsx` / `layout.tsx`）导出，不能从客户端组件（带 `"use client"` 的文件）导出。

**坑 5：title template 需要在父级 layout 配置**
```tsx
// layout.tsx
export const metadata: Metadata = {
  title: {
    template: "%s | 我的网站",
    default: "我的网站",
  },
};

// page.tsx（子页面只需写短标题）
export const metadata: Metadata = {
  title: "关于我们",  // 最终渲染：<title>关于我们 | 我的网站</title>
};
```

### 4.3 中间件相关

**坑 6：middleware.ts 必须放在正确位置**
- 使用 `src/` 目录时：放在 `src/middleware.ts`（与 `src/app/` 平级）
- 不使用 `src/` 目录时：放在项目根目录（与 `app/` 平级）
- 放在 `app/` 目录内部**不会生效**！

**坑 7：不配置 matcher 导致性能问题**
没有 matcher 时，所有请求（包括 CSS、图片、字体文件）都会触发中间件，显著增加响应延迟。

**坑 8：中间件中无法直接访问数据库**
Edge Runtime 不支持 TCP 连接，Prisma 等 ORM 在中间件中不可用。认证逻辑应将重的部分移到 API Route 或 Server Action 中。

---

## 五、小练习

1. **CSS Module 练习**：新建 `src/app/demo-card/` 目录，创建 `Card.tsx` 和 `Card.module.css`，在 CSS Module 中定义 `.card`、`.title`、`.body` 三个类，在组件中使用，并在主页面引入这个组件验证样式隔离效果。

2. **Metadata 练习**：在本项目 `src/app/page.tsx` 中修改 `metadata` 导出，设置 `title`（对象形式，带 template）和 `openGraph`（含图片），打开浏览器 DevTools 验证 `<head>` 中生成的标签。

3. **generateMetadata 练习**：新建 `src/app/blog/[slug]/page.tsx`，添加 `generateMetadata` 函数，根据 `slug` 参数动态返回 `title: "文章 · ${slug}"`，在浏览器中切换不同路径，观察标签页标题的变化。

4. **中间件理解练习**：阅读 Next.js 官方文档的 [Middleware](https://nextjs.org/docs/app/building-your-application/routing/middleware) 页面，思考如果要实现「未登录用户访问 `/dashboard` 自动跳转到 `/login`」，`middleware.ts` 应该如何写？写出伪代码并在本章页面的注释中记录你的思路。
