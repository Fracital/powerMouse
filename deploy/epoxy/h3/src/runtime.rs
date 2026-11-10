//! quinn's runtime on a browser event loop: tasks are `spawn_local`, timers
//! are `setTimeout`. The page is single threaded, so the `Send` bounds quinn
//! asks for are met with `SendWrapper`.

use std::{
	fmt,
	future::Future,
	pin::Pin,
	task::{Context, Poll},
};

use gloo_timers::future::TimeoutFuture;
use quinn::{AsyncTimer, Runtime};
use send_wrapper::SendWrapper;
use web_time::Instant;

#[derive(Debug)]
pub struct BrowserRuntime;

impl Runtime for BrowserRuntime {
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
	sleep: Option<SendWrapper<TimeoutFuture>>,
}

impl fmt::Debug for Timer {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Timer").field("deadline", &self.deadline).finish()
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
				self.sleep = Some(SendWrapper::new(TimeoutFuture::new(ms.min(u32::MAX as u128) as u32)));
			}
			let sleep = self.sleep.as_mut().unwrap();
			match Pin::new(&mut **sleep).poll(cx) {
				Poll::Ready(()) => {
					// setTimeout may fire a little early against a monotonic
					// clock: loop and re-arm for what is left
					self.sleep = None;
				}
				Poll::Pending => return Poll::Pending,
			}
		}
	}
}
