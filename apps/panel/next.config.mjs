/** Static export only: no API routes, no server actions, no analytics (CLAUDE.md rule 1). */
const config = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@oisniper/core"],
  poweredByHeader: false,
  reactStrictMode: true,
};
export default config;
