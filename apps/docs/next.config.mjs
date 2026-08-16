import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const basePath = process.env.GITHUB_ACTIONS ? "/agentscope" : "";

const nextConfig = {
  output: "export",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  images: { unoptimized: true },
};

export default createMDX({
  // Keep source discovery explicit so static builds include only public guides.
  include: ["content/docs/**/*.mdx"],
})(nextConfig);
