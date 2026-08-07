import prefixSelector from 'postcss-prefix-selector'

export default {
  plugins: [
    prefixSelector({
      prefix: '.medira-shell',
      transform(prefix, selector, prefixedSelector, filePath) {
        if (!filePath?.replace(/\\/g, '/').includes('/src/medira/index.css')) return selector
        if (selector === ':root' || ['html', 'body', '#root'].includes(selector)) return prefix
        if (selector.startsWith(prefix)) return selector
        return prefixedSelector
      },
    }),
  ],
}
