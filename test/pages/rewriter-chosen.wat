;; A rewriter module of the page's own making, in the buffer ABI of
;; src/wasm/module.ts: it answers revision "2", says every script parses,
;; and "rewrites" every script into the page's own text.
(module
  (memory (export "memory") 1)
  ;; the answer: at 4096, its length in global $len
  (data (i32.const 4096) "2")
  (data (i32.const 4352) "0\09")
  (data (i32.const 4608) "1")
  (data (i32.const 8192) "document.documentElement.setAttribute('data-rewriter','the top page chose it');")
  (global $ptr (mut i32) (i32.const 4096))
  (global $len (mut i32) (i32.const 0))
  (func (export "a") (param i32) (result i32) (i32.const 16384))
  (func (export "b") (result i32) (i32.const 32768))
  (func (export "c") (param i32 i32) (result i32) (i32.const 0))
  (func (export "p") (result i32) (global.get $ptr))
  (func (export "n") (result i32) (global.get $len))
  (func (export "r") (param $p i32) (param $l i32) (param $f i32) (result i32)
    ;; revision
    (if (i32.and (local.get $f) (i32.const 32))
      (then (global.set $ptr (i32.const 4096)) (global.set $len (i32.const 1)) (return (i32.const 0))))
    ;; params
    (if (i32.and (local.get $f) (i32.const 8))
      (then (global.set $ptr (i32.const 4096)) (global.set $len (i32.const 0)) (return (i32.const 0))))
    ;; meta: nothing kept
    (if (i32.and (local.get $f) (i32.const 16))
      (then (global.set $ptr (i32.const 4352)) (global.set $len (i32.const 2)) (return (i32.const 0))))
    ;; parses / single: yes
    (if (i32.and (local.get $f) (i32.const 192))
      (then (global.set $ptr (i32.const 4608)) (global.set $len (i32.const 1)) (return (i32.const 0))))
    ;; a rewrite: the page's text
    (global.set $ptr (i32.const 8192))
    (global.set $len (i32.const 79))
    (i32.const 0))
)
