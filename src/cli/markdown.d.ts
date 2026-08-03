// Bun 的 text loader 将 Markdown 资源作为字符串内联到 CLI bundle。
declare module '*.md' {
  const content: string;
  export default content;
}
