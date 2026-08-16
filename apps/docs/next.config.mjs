import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath: process.env.GITHUB_ACTIONS ? "/agentscope" : "",
  images: { unoptimized: true },
};

export default createMDX({
  // Keep source discovery explicit so static builds include only public guides.
  include: ["content/docs/**/*.mdx"],
})(nextConfig);
