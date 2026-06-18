/**
 * 第 01 章页面：起步与项目结构
 *
 * 这是一个「服务端组件」（Server Component）。
 * App Router 中，所有组件默认都在服务器上运行，无需任何声明。
 * 服务器渲染完成后，才把 HTML 发送给浏览器——这正是 Next.js SSR 的核心。
 *
 * 本文件是本项目（chapter-01-getting-started）的根路由页面，
 * 访问 http://localhost:3000 即可看到此页面。
 */

// ─── 本页面不需要任何额外 import ──────────────────────────────────────────────
// 全局样式已由根布局 (layout.tsx) 引入，这里直接使用 .card / .demo-box 等 class。

export default function Chapter01Page() {
  return (
    // 页面顶层容器：无需额外样式，根布局的 .content 已限制宽度与内边距
    <div>
      {/* ── 标题与简介 ─────────────────────────────────────────────────────── */}
      <h1>第 01 章 · 起步与项目结构</h1>
      <p>
        本章带你认识 Next.js 是什么、它解决了哪些问题，
        并深入了解 App Router 的目录约定与「文件即路由」的核心思想。
        读完本章，你将能够创建并运行一个最小的 Next.js 项目。
      </p>

      {/* ── 1. Next.js 是什么 ──────────────────────────────────────────────── */}
      <h2>1. Next.js 是什么？</h2>
      <p>
        Next.js 是基于 React 的<strong>全栈 Web 框架</strong>，由 Vercel 开发并开源。
        它在 React 之上提供了三大核心能力：
      </p>
      <ul>
        {/*
         * SSR / SSG / ISR：
         *   - SSR（Server-Side Rendering）：每次请求在服务器上实时渲染 HTML，
         *     首屏速度快、对 SEO 友好。
         *   - SSG（Static Site Generation）：构建时生成静态 HTML，CDN 直接分发。
         *   - ISR（Incremental Static Regeneration）：静态页面定期重新生成，兼顾性能与时效性。
         */}
        <li>
          <strong>服务端渲染（SSR）与静态生成（SSG）</strong>
          ——解决了纯 React SPA 首屏白屏和 SEO 差的问题。
        </li>
        {/*
         * 约定式路由：
         *   不需要像 React Router 那样手动注册路由，
         *   只要在特定目录里创建文件，Next.js 就自动生成对应的 URL 路径。
         */}
        <li>
          <strong>约定式文件系统路由</strong>
          ——目录结构即路由结构，零配置，上手即用。
        </li>
        {/*
         * 全栈能力：
         *   在同一个项目里，既可以写前端页面，也可以写后端 API 接口（Route Handlers）。
         *   无需额外搭建 Node 服务器。
         */}
        <li>
          <strong>全栈能力</strong>
          ——Route Handlers（API 路由）让前后端共存于同一仓库，部署更简单。
        </li>
      </ul>

      {/* ── 2. App Router vs Pages Router ─────────────────────────────────── */}
      <h2>2. App Router 与 Pages Router</h2>
      <p>
        Next.js 同时存在两套路由系统，初学者常感困惑：
      </p>
      {/*
       * 用 .card 展示对比信息，是本教程约定的「信息卡片」样式。
       * .card 的背景色和边框由 globals.css 定义，这里只需写 className 即可。
       */}
      <div className="card">
        <p style={{ margin: "0 0 8px" }}>
          <strong>Pages Router</strong>（旧，<code>pages/</code> 目录）
          <span className="tag" style={{ marginLeft: 8 }}>Next.js 9+</span>
        </p>
        <p className="muted" style={{ margin: "0 0 12px" }}>
          使用 <code>getServerSideProps</code> / <code>getStaticProps</code> 等函数获取数据；
          路由基于 <code>pages/</code> 目录；组件默认在客户端运行。
          适合维护老项目，但不是本教程的重点。
        </p>

        <p style={{ margin: "0 0 8px" }}>
          <strong>App Router</strong>（新，<code>app/</code> 目录）
          <span className="tag" style={{ marginLeft: 8 }}>Next.js 13.4+ 稳定</span>
        </p>
        <p className="muted" style={{ margin: 0 }}>
          基于 React Server Components（RSC）；组件默认在服务器运行；
          支持流式渲染（Streaming）与更细粒度的缓存控制。
          <strong>本教程全程使用 App Router。</strong>
        </p>
      </div>

      {/* ── 3. src/app 目录约定 ────────────────────────────────────────────── */}
      <h2>3. <code>src/app</code> 目录约定</h2>
      <p>
        App Router 的核心是<strong>文件即路由</strong>：<code>src/app</code> 目录下的
        文件夹名就是 URL 路径，而文件夹内的特殊文件名决定了该路由的行为。
        以下是你最常见到的几个特殊文件：
      </p>

      {/*
       * 用 <pre><code> 展示项目结构树。
       * <pre> 保留空白和换行；globals.css 已为它设置了等宽字体和深色背景。
       *
       * 注意：本项目是独立的 chapter-01-getting-started 项目，
       * 根路由 / 就是本章页面，无需嵌套在子目录下。
       */}
      <pre>
        <code>{`src/app/
├── layout.tsx          ← 根布局：包裹所有页面，必须存在
├── page.tsx            ← 本章页面（URL: /）
├── globals.css         ← 全局样式（只在 layout 中 import）
│
├── blog/
│   ├── layout.tsx      ← 博客专属布局（嵌套布局）
│   ├── page.tsx        ← 博客列表（URL: /blog）
│   └── [slug]/
│       └── page.tsx    ← 博客详情（URL: /blog/any-slug）
│
└── api/
    └── hello/
        └── route.ts    ← API 接口（URL: /api/hello）`}</code>
      </pre>

      {/* ── 特殊文件名说明 ─────────────────────────────────────────────────── */}
      <h3>特殊文件名的含义</h3>
      {/*
       * 逐项说明每个特殊文件名——这是 App Router 的"约定"部分，必须记住。
       * 文件名是固定的，Next.js 通过识别文件名来决定它的用途。
       */}
      <div className="card">
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #232a36" }}>
              <th style={{ textAlign: "left", padding: "6px 12px 10px 0", color: "#9aa4b2" }}>文件名</th>
              <th style={{ textAlign: "left", padding: "6px 0 10px", color: "#9aa4b2" }}>作用</th>
            </tr>
          </thead>
          <tbody>
            {/*
             * page.tsx — 定义一个可访问的路由页面。
             * 没有 page.tsx，该目录不会生成可访问的 URL。
             */}
            <tr style={{ borderBottom: "1px solid #1c2230" }}>
              <td style={{ padding: "8px 12px 8px 0" }}><code>page.tsx</code></td>
              <td style={{ padding: "8px 0" }}>定义路由页面，是该 URL 的唯一入口。缺少它，路由不可访问。</td>
            </tr>
            {/*
             * layout.tsx — 包裹当前目录及所有子目录的布局，不会因页面切换而重新挂载。
             * 适合放导航栏、侧边栏等共享 UI。
             */}
            <tr style={{ borderBottom: "1px solid #1c2230" }}>
              <td style={{ padding: "8px 12px 8px 0" }}><code>layout.tsx</code></td>
              <td style={{ padding: "8px 0" }}>共享布局，渲染 <code>children</code>（当前页）；页面切换时不会销毁重建。</td>
            </tr>
            {/*
             * loading.tsx — 路由加载时显示的骨架屏或 Loading 状态。
             * Next.js 会自动用 React Suspense 包裹 page，显示 loading UI。
             */}
            <tr style={{ borderBottom: "1px solid #1c2230" }}>
              <td style={{ padding: "8px 12px 8px 0" }}><code>loading.tsx</code></td>
              <td style={{ padding: "8px 0" }}>路由加载时的占位 UI；Next.js 自动用 Suspense 包裹，无需手写。</td>
            </tr>
            {/*
             * error.tsx — 路由渲染出错时的错误边界。
             * 必须是客户端组件（文件顶部加 "use client"）。
             */}
            <tr style={{ borderBottom: "1px solid #1c2230" }}>
              <td style={{ padding: "8px 12px 8px 0" }}><code>error.tsx</code></td>
              <td style={{ padding: "8px 0" }}>路由级错误边界；捕获渲染错误并展示友好提示。必须是客户端组件。</td>
            </tr>
            {/*
             * not-found.tsx — 调用 notFound() 或 404 时显示的页面。
             */}
            <tr style={{ borderBottom: "1px solid #1c2230" }}>
              <td style={{ padding: "8px 12px 8px 0" }}><code>not-found.tsx</code></td>
              <td style={{ padding: "8px 0" }}>自定义 404 页面；调用 <code>notFound()</code> 函数时触发。</td>
            </tr>
            {/*
             * route.ts — 定义 HTTP 接口（GET、POST 等），相当于 API 路由。
             * 同一目录不能同时存在 page.tsx 和 route.ts。
             */}
            <tr>
              <td style={{ padding: "8px 12px 8px 0" }}><code>route.ts</code></td>
              <td style={{ padding: "8px 0" }}>API 端点；导出 <code>GET</code>/<code>POST</code> 等函数处理 HTTP 请求。</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── 4. 文件即路由 ──────────────────────────────────────────────────── */}
      <h2>4. 文件即路由（File-based Routing）</h2>
      <p>
        App Router 的路由规则极简：<strong>目录名 = URL 路径段</strong>。
        你不需要写任何路由配置文件，Next.js 会自动扫描 <code>src/app</code> 目录：
      </p>
      <ul>
        {/* 静态路由：目录名固定，URL 也固定 */}
        <li>
          <code>src/app/about/page.tsx</code> → URL <code>/about</code>
        </li>
        {/* 嵌套路由：多层目录形成多段路径 */}
        <li>
          <code>src/app/blog/latest/page.tsx</code> → URL <code>/blog/latest</code>
        </li>
        {/* 动态路由：方括号内是参数名，匹配任意值 */}
        <li>
          <code>src/app/blog/[slug]/page.tsx</code> → URL <code>/blog/hello-world</code>（动态参数）
        </li>
        {/* 路由组：圆括号包裹的目录名不计入 URL */}
        <li>
          <code>src/app/(marketing)/home/page.tsx</code> → URL <code>/home</code>（路由组，括号不计入路径）
        </li>
      </ul>
      <p className="muted" style={{ fontSize: 14 }}>
        动态路由、路由组等进阶用法将在后续章节详细讲解。
      </p>

      {/* ── 5. 如何运行项目 ────────────────────────────────────────────────── */}
      <h2>5. 如何运行项目</h2>
      <p>
        本章是一个<strong>独立的 Next.js 项目</strong>（位于 <code>chapter-01-getting-started/</code>
        目录），进入该目录后执行以下命令：
      </p>
      <pre>
        <code>{`# 1. 进入本章项目目录
cd chapter-01-getting-started

# 2. 安装依赖
npm install

# 3. 启动开发服务器（默认端口 3000，支持热更新）
npm run dev

# 4. 打开浏览器访问
#    http://localhost:3000`}</code>
      </pre>
      <p>
        开发模式下，修改文件后浏览器会<strong>自动刷新</strong>，无需手动操作。
        如果要构建生产版本：
      </p>
      <pre>
        <code>{`npm run build   # 构建生产包（静态分析 + 编译）
npm start       # 运行生产服务器`}</code>
      </pre>

      {/* ── 6. 小 Demo：服务端渲染的「你好，Next.js！」 ─────────────────────── */}
      <h2>6. 小 Demo：第一个服务端渲染卡片</h2>
      <p>
        下面这段 JSX 就是在<strong>服务器上</strong>渲染成 HTML 再发给浏览器的——
        你可以打开浏览器的「查看页面源代码」（Ctrl+U），
        会看到这段内容已经以完整 HTML 的形式出现，而不是空的 <code>{'<div id="root">'}</code>。
      </p>

      {/*
       * .demo-box：带蓝色虚线边框的演示区域，在 globals.css 中定义。
       * 这段 JSX 完全在服务器渲染——没有 "use client"，没有 useEffect，
       * 所有 HTML 在服务器生成完毕后才发送给浏览器。
       * 这就是服务端组件（Server Component）的核心价值：
       *   - 更快的首屏加载（浏览器直接收到 HTML）
       *   - 更好的 SEO（爬虫能直接读取内容）
       *   - 更小的 JS bundle（服务端逻辑不打包进客户端）
       */}
      <div className="demo-box">
        {/* 卡片头部：用 tag 展示渲染位置标记 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 28 }}>👋</span>
          <span className="tag">Server Component · 服务端渲染</span>
        </div>

        {/* 主标语 */}
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          你好，Next.js！
        </div>

        {/* 说明文字 */}
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 14 }}>
          这个卡片是在<strong style={{ color: "#e6e9ef" }}>服务器</strong>上渲染的。
          当浏览器请求这个页面时，Next.js 已经把完整的 HTML 准备好了，
          直接发送过来——浏览器无需等待 JavaScript 执行就能看到内容。
        </p>

        {/* 渲染时间：服务端组件可以直接调用 Date，不需要 useEffect */}
        <p style={{ margin: 0, fontSize: 13 }}>
          <span className="muted">渲染时间（服务器时钟）：</span>
          {/*
           * 这里直接 new Date() 是在服务器上执行的。
           * 客户端组件里做同样的事情会导致「水合不匹配」（Hydration Mismatch）警告，
           * 因为服务端和客户端的时间戳不同。
           * 服务端组件没有这个问题，因为它根本不在客户端运行。
           */}
          <code style={{ marginLeft: 6 }}>{new Date().toLocaleString("zh-CN")}</code>
        </p>
      </div>

      <p style={{ fontSize: 14 }} className="muted">
        注意：上方卡片中的时间戳是构建或请求时在服务器上生成的，刷新页面会更新（SSR 模式）。
        这与纯客户端 React 应用中用 <code>useEffect</code> 设置时间的方式完全不同。
      </p>

      {/* ── 本章小结 ──────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 32 }}>
        <h3 style={{ marginTop: 0 }}>本章小结</h3>
        <ul style={{ marginBottom: 0 }}>
          {/* 要点 1：Next.js 定位 */}
          <li>
            Next.js 是基于 React 的全栈框架，提供 SSR/SSG、约定式路由和全栈 API 能力。
          </li>
          {/* 要点 2：两套路由系统 */}
          <li>
            存在 Pages Router（旧）和 App Router（新）两套系统；本教程使用 App Router。
          </li>
          {/* 要点 3：特殊文件名 */}
          <li>
            <code>app/</code> 目录下的特殊文件名（<code>page.tsx</code>、<code>layout.tsx</code>、
            <code>loading.tsx</code>、<code>error.tsx</code>、<code>not-found.tsx</code>、
            <code>route.ts</code>）有固定含义，Next.js 自动识别。
          </li>
          {/* 要点 4：文件即路由 */}
          <li>
            目录名 = URL 路径段；无需路由配置文件，文件系统就是路由表。
          </li>
          {/* 要点 5：服务端组件 */}
          <li>
            App Router 中组件默认为服务端组件，在服务器渲染完整 HTML 后发送给浏览器，
            首屏快且 SEO 友好。
          </li>
          {/* 要点 6：运行方式 */}
          <li>
            <code>npm run dev</code> 启动开发服务器（热更新）；<code>npm run build &amp;&amp; npm start</code> 运行生产版本。
          </li>
        </ul>
      </div>
    </div>
  );
}
