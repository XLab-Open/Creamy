/**
 * Next.js 配置文件（可选，但几乎每个项目都会有）。
 *
 * - 文件名用 .mjs，可直接用 ESM 的 `export default`。
 * - 即使留空 {}，Next.js 也能正常运行；这里只开启严格模式。
 *
 * @type {import("next").NextConfig}
 */
const nextConfig = {
  // 开发模式下对组件做额外检查（某些副作用会执行两次以暴露问题）。
  reactStrictMode: true,
};

export default nextConfig;
