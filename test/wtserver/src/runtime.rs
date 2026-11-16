//! quinn's runtime on Node's event loop: tasks are `spawn_local`, timers are
//! `setTimeout`. The module runs on one thread, so the `Send` bounds quinn
//! asks for are met with `SendWrapper`.

use std::{
	cell::RefCell,
	fmt,
	future::Future,
	pin::Pin,
	rc::Rc,
	task::{Context, Poll, Waker},
	time::Duration,
};

use quinn::{AsyncTimer, Runtime};
use send_wrapper::SendWrapper;
use wasm_bindgen::prelude::*;
use web_time::Instant;

#[wasm_bindgen]
extern "C" {
	#[wasm_bindgen(js_name = setTimeout)]
	fn set_timeout(callback: &Closure<dyn FnMut()>, ms: f64) -> JsValue;
	#[wasm_bindgen(js_name = clearTimeout)]
	fn clear_timeout(handle: &JsValue);
}

#[derive(Default)]
struct Shared {
	done: bool,
	waker: Option<Waker>,
}

/// A future that is ready after `ms` milliseconds (one `setTimeout`).
pub struct Sleep {
	shared: Rc<RefCell<Shared>>,
	handle: JsValue,
	_callback: Closure<dyn FnMut()>,
}

impl Sleep {
	pub fn new(ms: f64) -> Self {
		let shared = Rc::new(RefCell::new(Shared::default()));
		let inner = shared.clone();
		let callback = Closure::<dyn FnMut()>::new(move || {
			let mut s = inner.borrow_mut();
			s.done = true;
			if let Some(w) = s.waker.take() {
				w.wake();
			}
		});
		let handle = set_timeout(&callback, ms.max(0.0));
		Self {
			shared,
			handle,
			_callback: callback,
		}
	}
}

impl Future for Sleep {
	type Output = ();
	fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<()> {
		let mut s = self.shared.borrow_mut();
		if s.done {
			Poll::Ready(())
		} else {
			s.waker = Some(cx.waker().clone());
			Poll::Pending
		}
	}
}

impl Drop for Sleep {
	fn drop(&mut self) {
		if !self.shared.borrow().done {
			clear_timeout(&self.handle);
		}
	}
}

pub fn sleep(d: Duration) -> Sleep {
	Sleep::new(d.as_secs_f64() * 1000.0)
}

#[derive(Debug)]
pub struct NodeRuntime;

impl Runtime for NodeRuntime {
	fn new_timer(&self, deadline: Instant) -> Pin<Box<dyn AsyncTimer>> {
		Box::pin(Timer {
			deadline,
			sleep: None,
		})
	}

	fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send>>) {
		wasm_bindgen_futures::spawn_local(future);
	}
}

struct Timer {
	deadline: Instant,
	sleep: Option<SendWrapper<Sleep>>,
}

impl fmt::Debug for Timer {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Timer").finish_non_exhaustive()
	}
}

impl AsyncTimer for Timer {
	fn reset(mut self: Pin<&mut Self>, deadline: Instant) {
		self.deadline = deadline;
		self.sleep = None;
	}

	fn poll(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<()> {
		loop {
			let now = Instant::now();
			if now >= self.deadline {
				self.sleep = None;
				return Poll::Ready(());
			}
			if self.sleep.is_none() {
				let ms = (self.deadline - now).as_micros().div_ceil(1000);
				self.sleep = Some(SendWrapper::new(Sleep::new(ms.min(u32::MAX as u128) as f64)));
			}
			let sleep = self.sleep.as_mut().unwrap();
			match Pin::new(&mut **sleep).poll(cx) {
				// setTimeout may fire a little early against the monotonic
				// clock: loop and re-arm for what is left
				Poll::Ready(()) => self.sleep = None,
				Poll::Pending => return Poll::Pending,
			}
		}
	}
}
