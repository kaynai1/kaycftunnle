// 命令行口令输入：优先关闭终端回显，管道/重定向输入时退化为普通读取。

import readline from "node:readline";

function readPlain(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

export async function readPassphrase(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return readPlain(question);
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      fn(value);
    };
    function onData(chunk) {
      for (const ch of String(chunk)) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") return finish(resolve);
        if (ch === "\u0003") return finish(reject.bind(null, new Error("已取消")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    }
    stdin.on("data", onData);
  });
}

export function ask(question) {
  return readPlain(question);
}
