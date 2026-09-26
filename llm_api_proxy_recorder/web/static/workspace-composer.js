"use strict";

/* Keep native command text behind inline, removable skill mentions. */
function createWorkspaceComposer(input, createMention) {
  function readText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data.replaceAll("\u00a0", " ");
    if (node.nodeType === Node.ELEMENT_NODE && node.dataset.skillCommand) return node.dataset.skillCommand;
    if (node.nodeName === "BR") return "\n";
    let text = "";
    for (const child of node.childNodes) {
      const block = child.nodeName === "DIV" || child.nodeName === "P";
      if (block && text && !text.endsWith("\n")) text += "\n";
      text += readText(child);
      if (block && child.nextSibling && !text.endsWith("\n")) text += "\n";
    }
    return text;
  }

  // Editable browsers keep a final line break as a caret placeholder.
  function value() {
    const text = readText(input);
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  }

  function textNode(text) {
    return document.createTextNode(text.endsWith("\n") ? text + "\n" : text);
  }

  function offsetAt(node, offset) {
    const range = document.createRange();
    range.selectNodeContents(input);
    range.setEnd(node, offset);
    return readText(range.cloneContents()).length;
  }

  function selectionOffsets() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !input.contains(selection.anchorNode) || !input.contains(selection.focusNode)) return null;
    return {
      anchor: offsetAt(selection.anchorNode, selection.anchorOffset),
      focus: offsetAt(selection.focusNode, selection.focusOffset),
    };
  }

  function pointAt(offset) {
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest("[data-skill-command]")) return NodeFilter.FILTER_REJECT;
        return node.nodeType === Node.TEXT_NODE || node.dataset.skillCommand || node.nodeName === "BR"
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      const start = offsetAt(node.parentNode, index);
      const length = readText(node).length;
      if (offset > start + length) continue;
      if (node.nodeType === Node.TEXT_NODE) return [node, Math.max(0, offset - start)];
      return [node.parentNode, index + (offset > start ? 1 : 0)];
    }
    return [input, input.childNodes.length];
  }

  function setSelectionRange(anchor, focus = anchor) {
    const selection = window.getSelection();
    if (!selection) return;
    const start = pointAt(anchor), end = pointAt(focus);
    selection.setBaseAndExtent(start[0], start[1], end[0], end[1]);
  }

  function highlightSkill(skill) {
    const chip = input.querySelector("[data-skill-command]");
    if (chip?.dataset.skillCommand === (skill ? `/${skill.name}` : undefined)) return;
    const text = value();
    const selection = selectionOffsets();
    input.replaceChildren();
    const prefix = skill ? text.match(/^\s*\/[^\s]+/)?.[0] : "";
    if (prefix) {
      const leading = prefix.slice(0, prefix.indexOf("/"));
      if (leading) input.append(document.createTextNode(leading));
      const mention = createMention(skill);
      mention.contentEditable = "false";
      mention.dataset.skillCommand = `/${skill.name}`;
      mention.setAttribute("aria-label", `技能 ${skill.name}`);
      mention.setAttribute("draggable", "false");
      input.append(mention, textNode(text.slice(prefix.length)));
    } else if (text) input.append(textNode(text));
    if (selection) setSelectionRange(selection.anchor, selection.focus);
  }

  // Copy native slash syntax so pasted mentions can be recognized again.
  function copySelection(event) {
    const selection = selectionOffsets();
    if (!event.clipboardData || !selection || selection.anchor === selection.focus) return false;
    event.preventDefault();
    event.clipboardData.setData("text/plain", value().slice(
      Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)));
    return true;
  }
  input.addEventListener("copy", (event) => {
    copySelection(event);
  });
  input.addEventListener("cut", (event) => {
    if (copySelection(event)) document.execCommand("delete");
  });

  return {
    get value() { return value(); },
    set value(text) { input.replaceChildren(...(text ? [textNode(text)] : [])); },
    get selectionStart() {
      const selection = selectionOffsets();
      return selection ? Math.min(selection.anchor, selection.focus) : readText(input).length;
    },
    setSelectionRange,
    highlightSkill,
  };
}
