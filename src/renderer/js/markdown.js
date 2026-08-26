/* A small Markdown renderer that builds DOM nodes directly.

   Notes come out of the database, so nothing here ever touches innerHTML: every
   piece of text goes in as a text node, and only the structure comes from the
   markup. A note containing <script> is therefore just a note that says
   "<script>". */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h } = IV.dom;

  /* ------------------------------------------------------------- inline */

  const INLINE = [
    { name: 'code', re: /`([^`]+)`/ },
    { name: 'bold', re: /\*\*([^*]+)\*\*/ },
    { name: 'bolt', re: /__([^_]+)__/ },
    { name: 'strike', re: /~~([^~]+)~~/ },
    { name: 'italic', re: /\*([^*]+)\*/ },
    { name: 'ital2', re: /_([^_]+)_/ },
    { name: 'link', re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/ },
    { name: 'auto', re: /(https?:\/\/[^\s<>"]+)/ }
  ];

  function renderInline(text, into) {
    let earliest = null;

    for (const rule of INLINE) {
      const match = rule.re.exec(text);
      if (match && (!earliest || match.index < earliest.match.index)) {
        earliest = { rule, match };
      }
    }

    if (!earliest) {
      if (text) into.append(document.createTextNode(text));
      return;
    }

    const { rule, match } = earliest;
    if (match.index > 0) into.append(document.createTextNode(text.slice(0, match.index)));

    if (rule.name === 'code') {
      into.append(h('code', { text: match[1] }));
    } else if (rule.name === 'bold' || rule.name === 'bolt') {
      const strong = h('strong');
      renderInline(match[1], strong);
      into.append(strong);
    } else if (rule.name === 'italic' || rule.name === 'ital2') {
      const em = h('em');
      renderInline(match[1], em);
      into.append(em);
    } else if (rule.name === 'strike') {
      const del = h('del');
      renderInline(match[1], del);
      into.append(del);
    } else if (rule.name === 'link' || rule.name === 'auto') {
      const label = rule.name === 'link' ? match[1] : match[1];
      const href = rule.name === 'link' ? match[2] : match[1];
      into.append(
        h('a', {
          class: 'md-link',
          href: '#',
          text: label,
          title: href,
          onClick: (e) => {
            e.preventDefault();
            IV.api.openUrl(href).catch((err) => IV.dom.toast(err.message, 'error'));
          }
        })
      );
    }

    renderInline(text.slice(match.index + match[0].length), into);
  }

  /* -------------------------------------------------------------- block */

  function render(source) {
    const root = h('div', { class: 'md' });
    const lines = String(source == null ? '' : source).split(/\r?\n/);

    let i = 0;
    let list = null;
    let listOrdered = false;

    const closeList = () => {
      list = null;
    };

    while (i < lines.length) {
      const line = lines[i];

      /* fenced code */
      if (/^\s*```/.test(line)) {
        closeList();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        root.append(h('pre', { class: 'md-pre' }, h('code', { text: body.join('\n') })));
        continue;
      }

      /* horizontal rule */
      if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && !/[^\s\-*_]/.test(line)) {
        closeList();
        root.append(h('hr', { class: 'md-hr' }));
        i++;
        continue;
      }

      /* heading */
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const node = h('h' + Math.min(6, heading[1].length), { class: 'md-h' });
        renderInline(heading[2], node);
        root.append(node);
        i++;
        continue;
      }

      /* blockquote */
      if (/^\s*>\s?/.test(line)) {
        closeList();
        const body = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        const quote = h('blockquote', { class: 'md-quote' });
        renderInline(body.join(' '), quote);
        root.append(quote);
        continue;
      }

      /* task list and bullets */
      const bullet = /^\s*([-*+])\s+(.*)$/.exec(line);
      const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        const ordered = Boolean(numbered);
        if (!list || listOrdered !== ordered) {
          list = h(ordered ? 'ol' : 'ul', { class: 'md-list' });
          listOrdered = ordered;
          root.append(list);
        }
        const item = h('li');
        let content = (bullet || numbered)[2];
        const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
        if (task) {
          item.append(
            h('input', { type: 'checkbox', checked: task[1].toLowerCase() === 'x', disabled: true, class: 'md-task' })
          );
          content = task[2];
        }
        renderInline(content, item);
        list.append(item);
        i++;
        continue;
      }

      /* blank line ends a list and a paragraph */
      if (!line.trim()) {
        closeList();
        i++;
        continue;
      }

      /* paragraph, joining soft wrapped lines */
      closeList();
      const paragraph = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*```/.test(lines[i]) &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^\s*([-*+])\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i])
      ) {
        paragraph.push(lines[i++]);
      }
      const node = h('p', { class: 'md-p' });
      renderInline(paragraph.join('\n'), node);
      root.append(node);
    }

    return root;
  }

  /** True when the text uses enough markup to be worth rendering. */
  function looksLikeMarkdown(text) {
    const source = String(text || '');
    return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:/.test(source);
  }

  IV.markdown = { render, looksLikeMarkdown };
})(window.IV);
