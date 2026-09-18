/** Static preview only: no scripts, external resources, navigation or native bridge. */
export function staticDocumentPreview(content: string): string {
  const parsed = new DOMParser().parseFromString(content, 'text/html');
  parsed
    .querySelectorAll(
      'script,meta,base,link,iframe,object,embed,form,foreignObject,animate,animateMotion,animateTransform,set',
    )
    .forEach((element) => element.remove());
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on') ||
        [
          'srcdoc',
          'srcset',
          'action',
          'formaction',
          'ping',
          'target',
          'href',
          'xlink:href',
        ].includes(name) ||
        (['href', 'xlink:href', 'src', 'poster', 'data', 'background'].includes(name) &&
          !attribute.value.startsWith('data:image/'))
      )
        element.removeAttribute(attribute.name);
    }
  }
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>body{font:16px/1.6 system-ui;color:#303832;background:#fffdf8;padding:24px;overflow-wrap:anywhere}img,svg{max-width:100%}</style>${[...parsed.head.querySelectorAll('style')].map((style) => style.outerHTML).join('')}${parsed.body.innerHTML}`;
}
