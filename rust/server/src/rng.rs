#[derive(Clone, Debug)]
pub struct Rng {
    seed: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self { seed }
    }

    pub fn next_f32(&mut self) -> f32 {
        self.seed = self.seed.wrapping_add(0x6d2b79f5);
        let mut t = self.seed;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        let out = t ^ (t >> 14);
        (out as f64 / 4_294_967_296.0) as f32
    }

    pub fn int(&mut self, min: i32, max: i32) -> i32 {
        if max <= min {
            return min;
        }
        let span = (max - min + 1) as f32;
        min + (self.next_f32() * span).floor() as i32
    }

    pub fn bool(&mut self, probability: f32) -> bool {
        self.next_f32() < probability
    }

    pub fn pick_index(&mut self, len: usize) -> usize {
        if len <= 1 {
            return 0;
        }
        (self.next_f32() * len as f32).floor().min((len - 1) as f32) as usize
    }
}
