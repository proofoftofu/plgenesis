"""
Autoresearch pretraining script. Single-GPU, single-file.
Cherry-picked and simplified from nanochat.
Usage: uv run train.py
"""

import os
os.environ["PYTORCH_ALLOC_CONF"] = "expandable_segments:True"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

import gc
import json
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

import sys
import torch
import torch.nn as nn
import torch.nn.functional as F
import prepare as prepare_module

def verify_macos_env():
    if sys.platform != "darwin":
        raise RuntimeError(f"This script requires macOS with Metal. Detected platform: {sys.platform}")
    if not torch.backends.mps.is_available():
        raise RuntimeError("MPS (Metal Performance Shaders) is not available. Ensure you are running on Apple Silicon with a compatible PyTorch build.")
    print("Environment verified: macOS detected with Metal (MPS) hardware acceleration available.")
    print()

verify_macos_env()

from prepare import MAX_SEQ_LEN, TIME_BUDGET, Tokenizer, make_dataloader, evaluate_bpb


def env_int(name, default):
    value = os.getenv(name)
    return int(value) if value is not None else default


def env_float(name, default):
    value = os.getenv(name)
    return float(value) if value is not None else default


def env_str(name, default):
    value = os.getenv(name)
    return value if value is not None else default


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def json_ready(value):
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {k: json_ready(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_ready(v) for v in value]
    return value


class RunArtifactWriter:
    def __init__(self, metadata, controls, artifact_paths):
        self.metadata = metadata
        self.controls = controls
        self.artifact_paths = artifact_paths
        self.events_path = Path(artifact_paths["run_events_path"])
        self.final_path = Path(artifact_paths["run_final_path"])
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        self.final_path.parent.mkdir(parents=True, exist_ok=True)
        self.events_path.write_text("", encoding="utf-8")
        self.status = "initialized"
        self.started_at = None
        self.finished_at = None
        self.last_step = 0

    def emit_event(self, event, status, step=None, metrics=None, extra=None, timestamp=None):
        payload = {
            "run_id": self.metadata["run_id"],
            "scheduled_run_id": self.metadata["scheduled_run_id"],
            "direction_id": self.metadata["direction_id"],
            "direction_slug": self.metadata["direction_slug"],
            "mode": self.metadata["mode"],
            "branch_target": self.metadata["branch_target"],
            "timestamp": timestamp or utc_now(),
            "event": event,
            "status": status,
            "step": step,
            "metrics": metrics or {},
        }
        if extra:
            payload.update(extra)
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(json_ready(payload), sort_keys=True) + "\n")
        self.status = status
        if step is not None:
            self.last_step = step
        if event == "run_start" and self.started_at is None:
            self.started_at = payload["timestamp"]
        if event in ("run_finish", "run_failure"):
            self.finished_at = payload["timestamp"]
        return payload

    def write_final_record(self, status, metrics=None, extra=None, error=None):
        payload = {
            "run_id": self.metadata["run_id"],
            "direction_id": self.metadata["direction_id"],
            "direction_slug": self.metadata["direction_slug"],
            "scheduled_run_id": self.metadata["scheduled_run_id"],
            "mode": self.metadata["mode"],
            "branch_target": self.metadata["branch_target"],
            "status": status,
            "controls": self.controls,
            "artifact_paths": self.artifact_paths,
            "timestamps": {
                "started_at": self.started_at,
                "finished_at": self.finished_at or utc_now(),
            },
            "metrics": metrics or {},
            "last_step": self.last_step,
        }
        if extra:
            payload.update(extra)
        if error:
            payload["error"] = error
        self.final_path.write_text(json.dumps(json_ready(payload), indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return payload

# ---------------------------------------------------------------------------
# GPT Model
# ---------------------------------------------------------------------------

@dataclass
class GPTConfig:
    sequence_len: int = 2048
    vocab_size: int = 32768
    n_layer: int = 12
    n_head: int = 6
    n_kv_head: int = 6
    n_embd: int = 768
    window_pattern: str = "SSSL"


def norm(x):
    return F.rms_norm(x, (x.size(-1),))


def has_ve(layer_idx, n_layer):
    """Returns True if layer should have Value Embedding (alternating, last always included)."""
    return layer_idx % 2 == (n_layer - 1) % 2


def apply_rotary_emb(x, cos, sin):
    assert x.ndim == 4
    d = x.shape[3] // 2
    x1, x2 = x[..., :d], x[..., d:]
    y1 = x1 * cos + x2 * sin
    y2 = x1 * (-sin) + x2 * cos
    return torch.cat([y1, y2], 3)


class CausalSelfAttention(nn.Module):
    def __init__(self, config, layer_idx):
        super().__init__()
        self.n_head = config.n_head
        self.n_kv_head = config.n_kv_head
        self.n_embd = config.n_embd
        self.head_dim = self.n_embd // self.n_head
        assert self.n_embd % self.n_head == 0
        assert self.n_kv_head <= self.n_head and self.n_head % self.n_kv_head == 0
        self.c_q = nn.Linear(self.n_embd, self.n_head * self.head_dim, bias=False)
        self.c_k = nn.Linear(self.n_embd, self.n_kv_head * self.head_dim, bias=False)
        self.c_v = nn.Linear(self.n_embd, self.n_kv_head * self.head_dim, bias=False)
        self.c_proj = nn.Linear(self.n_embd, self.n_embd, bias=False)
        self.ve_gate_channels = 32
        self.ve_gate = nn.Linear(self.ve_gate_channels, self.n_kv_head, bias=False) if has_ve(layer_idx, config.n_layer) else None

    def forward(self, x, ve, cos_sin, window_size):
        B, T, C = x.size()
        q = self.c_q(x).view(B, T, self.n_head, self.head_dim)
        k = self.c_k(x).view(B, T, self.n_kv_head, self.head_dim)
        v = self.c_v(x).view(B, T, self.n_kv_head, self.head_dim)

        # Value residual (ResFormer): mix in value embedding with input-dependent gate per head
        if ve is not None:
            ve = ve.view(B, T, self.n_kv_head, self.head_dim)
            gate = 2 * torch.sigmoid(self.ve_gate(x[..., :self.ve_gate_channels]))
            v = v + gate.unsqueeze(-1) * ve

        cos, sin = cos_sin
        q, k = apply_rotary_emb(q, cos, sin), apply_rotary_emb(k, cos, sin)
        q, k = norm(q), norm(k)

        # PyTorch SDPA without FlashAttention 3
        # Expand heads for KV based on GQA
        k = k.repeat_interleave(self.n_head // self.n_kv_head, dim=2)
        v = v.repeat_interleave(self.n_head // self.n_kv_head, dim=2)
        
        # Transpose to [B, H, T, D]
        q = q.transpose(1, 2)
        k = k.transpose(1, 2)
        v = v.transpose(1, 2)
        
        # Apply mask for sliding window
        window = window_size[0]
        if window > 0 and window < T:
            # Mask out tokens outside the window
            mask = torch.ones(T, T, dtype=torch.bool, device=q.device).tril()
            mask = mask.triu(diagonal=1 - window)
            y = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
        else:
            y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
            
        y = y.transpose(1, 2).contiguous().view(B, T, -1)
        y = self.c_proj(y)
        return y


class MLP(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.c_fc = nn.Linear(config.n_embd, 4 * config.n_embd, bias=False)
        self.c_proj = nn.Linear(4 * config.n_embd, config.n_embd, bias=False)

    def forward(self, x):
        x = self.c_fc(x)
        x = F.relu(x).square()
        x = self.c_proj(x)
        return x


class Block(nn.Module):
    def __init__(self, config, layer_idx):
        super().__init__()
        self.attn = CausalSelfAttention(config, layer_idx)
        self.mlp = MLP(config)

    def forward(self, x, ve, cos_sin, window_size):
        x = x + self.attn(norm(x), ve, cos_sin, window_size)
        x = x + self.mlp(norm(x))
        return x


class GPT(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.config = config
        self.window_sizes = self._compute_window_sizes(config)
        self.transformer = nn.ModuleDict({
            "wte": nn.Embedding(config.vocab_size, config.n_embd),
            "h": nn.ModuleList([Block(config, i) for i in range(config.n_layer)]),
        })
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        self.resid_lambdas = nn.Parameter(torch.ones(config.n_layer))
        self.x0_lambdas = nn.Parameter(torch.zeros(config.n_layer))
        # Value embeddings
        head_dim = config.n_embd // config.n_head
        kv_dim = config.n_kv_head * head_dim
        self.value_embeds = nn.ModuleDict({
            str(i): nn.Embedding(config.vocab_size, kv_dim)
            for i in range(config.n_layer) if has_ve(i, config.n_layer)
        })
        # Rotary embeddings
        self.rotary_seq_len = config.sequence_len * 10
        cos, sin = self._precompute_rotary_embeddings(self.rotary_seq_len, head_dim)
        self.register_buffer("cos", cos, persistent=False)
        self.register_buffer("sin", sin, persistent=False)

    @torch.no_grad()
    def init_weights(self):
        # Embedding and unembedding
        torch.nn.init.normal_(self.transformer.wte.weight, mean=0.0, std=1.0)
        torch.nn.init.normal_(self.lm_head.weight, mean=0.0, std=0.001)
        # Transformer blocks
        n_embd = self.config.n_embd
        s = 3**0.5 * n_embd**-0.5
        for block in self.transformer.h:
            torch.nn.init.uniform_(block.attn.c_q.weight, -s, s)
            torch.nn.init.uniform_(block.attn.c_k.weight, -s, s)
            torch.nn.init.uniform_(block.attn.c_v.weight, -s, s)
            torch.nn.init.zeros_(block.attn.c_proj.weight)
            torch.nn.init.uniform_(block.mlp.c_fc.weight, -s, s)
            torch.nn.init.zeros_(block.mlp.c_proj.weight)
        # Per-layer scalars
        self.resid_lambdas.fill_(1.0)
        self.x0_lambdas.fill_(0.1)
        # Value embeddings
        for ve in self.value_embeds.values():
            torch.nn.init.uniform_(ve.weight, -s, s)
        # Gate weights init to zero (sigmoid(0)=0.5, scaled by 2 -> 1.0 = neutral)
        for block in self.transformer.h:
            if block.attn.ve_gate is not None:
                torch.nn.init.zeros_(block.attn.ve_gate.weight)
        # Rotary embeddings
        head_dim = self.config.n_embd // self.config.n_head
        cos, sin = self._precompute_rotary_embeddings(self.rotary_seq_len, head_dim)
        self.cos, self.sin = cos, sin
        # Cast embeddings to bf16
        self.transformer.wte.to(dtype=torch.bfloat16)
        for ve in self.value_embeds.values():
            ve.to(dtype=torch.bfloat16)

    def _precompute_rotary_embeddings(self, seq_len, head_dim, base=10000, device=None):
        if device is None:
            device = self.transformer.wte.weight.device
        channel_range = torch.arange(0, head_dim, 2, dtype=torch.float32, device=device)
        inv_freq = 1.0 / (base ** (channel_range / head_dim))
        t = torch.arange(seq_len, dtype=torch.float32, device=device)
        freqs = torch.outer(t, inv_freq)
        cos, sin = freqs.cos(), freqs.sin()
        cos, sin = cos.bfloat16(), sin.bfloat16()
        cos, sin = cos[None, :, None, :], sin[None, :, None, :]
        return cos, sin

    def _compute_window_sizes(self, config):
        pattern = config.window_pattern.upper()
        assert all(c in "SL" for c in pattern)
        long_window = config.sequence_len
        short_window = long_window // 2
        char_to_window = {"L": (long_window, 0), "S": (short_window, 0)}
        window_sizes = []
        for layer_idx in range(config.n_layer):
            char = pattern[layer_idx % len(pattern)]
            window_sizes.append(char_to_window[char])
        window_sizes[-1] = (long_window, 0)
        return window_sizes

    def estimate_flops(self):
        """Estimated FLOPs per token (forward + backward)."""
        nparams = sum(p.numel() for p in self.parameters())
        value_embeds_numel = sum(ve.weight.numel() for ve in self.value_embeds.values())
        nparams_exclude = (self.transformer.wte.weight.numel() + value_embeds_numel +
                          self.resid_lambdas.numel() + self.x0_lambdas.numel())
        h = self.config.n_head
        q = self.config.n_embd // self.config.n_head
        t = self.config.sequence_len
        attn_flops = 0
        for window_size in self.window_sizes:
            window = window_size[0]
            effective_seq = t if window < 0 else min(window, t)
            attn_flops += 12 * h * q * effective_seq
        return 6 * (nparams - nparams_exclude) + attn_flops

    def num_scaling_params(self):
        wte = sum(p.numel() for p in self.transformer.wte.parameters())
        value_embeds = sum(p.numel() for p in self.value_embeds.parameters())
        lm_head = sum(p.numel() for p in self.lm_head.parameters())
        transformer_matrices = sum(p.numel() for p in self.transformer.h.parameters())
        scalars = self.resid_lambdas.numel() + self.x0_lambdas.numel()
        total = wte + value_embeds + lm_head + transformer_matrices + scalars
        return {
            'wte': wte, 'value_embeds': value_embeds, 'lm_head': lm_head,
            'transformer_matrices': transformer_matrices, 'scalars': scalars, 'total': total,
        }

    def setup_optimizer(self, unembedding_lr=0.004, embedding_lr=0.2, matrix_lr=0.02,
                        weight_decay=0.0, adam_betas=(0.8, 0.95), scalar_lr=0.5):
        model_dim = self.config.n_embd
        matrix_params = list(self.transformer.h.parameters())
        value_embeds_params = list(self.value_embeds.parameters())
        embedding_params = list(self.transformer.wte.parameters())
        lm_head_params = list(self.lm_head.parameters())
        resid_params = [self.resid_lambdas]
        x0_params = [self.x0_lambdas]
        assert len(list(self.parameters())) == (len(matrix_params) + len(embedding_params) +
            len(lm_head_params) + len(value_embeds_params) + len(resid_params) + len(x0_params))
        # Scale LR ∝ 1/√dmodel (tuned at 768 dim)
        dmodel_lr_scale = (model_dim / 768) ** -0.5
        print(f"Scaling AdamW LRs by 1/sqrt({model_dim}/768) = {dmodel_lr_scale:.6f}")
        param_groups = [
            dict(kind='adamw', params=lm_head_params, lr=unembedding_lr * dmodel_lr_scale, betas=adam_betas, eps=1e-10, weight_decay=0.0),
            dict(kind='adamw', params=embedding_params, lr=embedding_lr * dmodel_lr_scale, betas=adam_betas, eps=1e-10, weight_decay=0.0),
            dict(kind='adamw', params=value_embeds_params, lr=embedding_lr * dmodel_lr_scale, betas=adam_betas, eps=1e-10, weight_decay=0.0),
            dict(kind='adamw', params=resid_params, lr=scalar_lr * 0.01, betas=adam_betas, eps=1e-10, weight_decay=0.0),
            dict(kind='adamw', params=x0_params, lr=scalar_lr, betas=(0.96, 0.95), eps=1e-10, weight_decay=0.0),
        ]
        for shape in sorted({p.shape for p in matrix_params}):
            group_params = [p for p in matrix_params if p.shape == shape]
            param_groups.append(dict(
                kind='muon', params=group_params, lr=matrix_lr,
                momentum=0.95, ns_steps=5, beta2=0.95, weight_decay=weight_decay,
            ))
        optimizer = MuonAdamW(param_groups)
        for group in optimizer.param_groups:
            group["initial_lr"] = group["lr"]
        return optimizer

    def forward(self, idx, targets=None, reduction='mean'):
        B, T = idx.size()
        assert T <= self.cos.size(1)
        cos_sin = self.cos[:, :T], self.sin[:, :T]

        x = self.transformer.wte(idx)
        x = norm(x)
        x0 = x
        for i, block in enumerate(self.transformer.h):
            x = self.resid_lambdas[i] * x + self.x0_lambdas[i] * x0
            ve = self.value_embeds[str(i)](idx) if str(i) in self.value_embeds else None
            x = block(x, ve, cos_sin, self.window_sizes[i])
        x = norm(x)

        softcap = 15
        logits = self.lm_head(x)
        logits = logits.float()
        logits = softcap * torch.tanh(logits / softcap)

        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1),
                                   ignore_index=-1, reduction=reduction)
            return loss
        return logits

# ---------------------------------------------------------------------------
# Optimizer (MuonAdamW, single GPU only)
# ---------------------------------------------------------------------------

polar_express_coeffs = [
    (8.156554524902461, -22.48329292557795, 15.878769915207462),
    (4.042929935166739, -2.808917465908714, 0.5000178451051316),
    (3.8916678022926607, -2.772484153217685, 0.5060648178503393),
    (3.285753657755655, -2.3681294933425376, 0.46449024233003106),
    (2.3465413258596377, -1.7097828382687081, 0.42323551169305323),
]


def adamw_step_fused(p, grad, exp_avg, exp_avg_sq, step_t, lr_t, beta1_t, beta2_t, eps_t, wd_t):
    # Move scalars to correct device and dtype
    step_t = step_t.to(device=p.device, dtype=p.dtype)
    lr_t = lr_t.to(device=p.device, dtype=p.dtype)
    beta1_t = beta1_t.to(device=p.device, dtype=p.dtype)
    beta2_t = beta2_t.to(device=p.device, dtype=p.dtype)
    eps_t = eps_t.to(device=p.device, dtype=p.dtype)
    wd_t = wd_t.to(device=p.device, dtype=p.dtype)
    
    p.mul_(1 - lr_t * wd_t)
    exp_avg.lerp_(grad, 1 - beta1_t)
    exp_avg_sq.lerp_(grad.square(), 1 - beta2_t)
    bias1 = 1 - beta1_t ** step_t
    bias2 = 1 - beta2_t ** step_t
    denom = (exp_avg_sq / bias2).sqrt() + eps_t
    step_size = lr_t / bias1
    p.add_(exp_avg / denom, alpha=-step_size)


def muon_step_fused(stacked_grads, stacked_params, momentum_buffer, second_momentum_buffer,
                    momentum_t, lr_t, wd_t, beta2_t, ns_steps, red_dim):
    # Move scalars to correct device and dtype
    momentum_t = momentum_t.to(device=stacked_params.device, dtype=stacked_params.dtype)
    lr_t = lr_t.to(device=stacked_params.device, dtype=stacked_params.dtype)
    wd_t = wd_t.to(device=stacked_params.device, dtype=stacked_params.dtype)
    beta2_t = beta2_t.to(device=stacked_params.device, dtype=stacked_params.dtype)

    # Nesterov momentum
    momentum = momentum_t.to(stacked_grads.dtype)
    momentum_buffer.lerp_(stacked_grads, 1 - momentum)
    g = stacked_grads.lerp_(momentum_buffer, momentum)
    # Polar express orthogonalization
    X = g.bfloat16()
    X = X / (X.norm(dim=(-2, -1), keepdim=True) * 1.02 + 1e-6)
    if g.size(-2) > g.size(-1):
        for a, b, c in polar_express_coeffs[:ns_steps]:
            A = X.mT @ X
            B = b * A + c * (A @ A)
            X = a * X + X @ B
    else:
        for a, b, c in polar_express_coeffs[:ns_steps]:
            A = X @ X.mT
            B = b * A + c * (A @ A)
            X = a * X + B @ X
    g = X
    # NorMuon variance reduction
    beta2 = beta2_t.to(g.dtype)
    v_mean = g.float().square().mean(dim=red_dim, keepdim=True)
    red_dim_size = g.size(red_dim)
    v_norm_sq = v_mean.sum(dim=(-2, -1), keepdim=True) * red_dim_size
    v_norm = v_norm_sq.sqrt()
    
    # Needs to match second_momentum_buffer.dtype for lerp_
    beta2_cast = beta2_t.to(second_momentum_buffer.dtype)
    second_momentum_buffer.lerp_(v_mean.to(dtype=second_momentum_buffer.dtype), 1 - beta2_cast)
    
    step_size = second_momentum_buffer.clamp_min(1e-10).rsqrt()
    scaled_sq_sum = (v_mean * red_dim_size) * step_size.float().square()
    v_norm_new = scaled_sq_sum.sum(dim=(-2, -1), keepdim=True).sqrt()
    final_scale = step_size * (v_norm / v_norm_new.clamp_min(1e-10))
    g = g * final_scale.to(g.dtype)
    # Cautious weight decay + parameter update
    lr = lr_t.to(g.dtype)
    wd = wd_t.to(g.dtype)
    mask = (g * stacked_params) >= 0
    stacked_params.sub_(lr * g + lr * wd * stacked_params * mask)


class MuonAdamW(torch.optim.Optimizer):
    """Combined optimizer: Muon for 2D matrix params, AdamW for others."""

    def __init__(self, param_groups):
        super().__init__(param_groups, defaults={})
        # 0-D CPU tensors to avoid torch.compile recompilation when values change
        self._adamw_step_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_lr_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_beta1_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_beta2_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_eps_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_wd_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._muon_momentum_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._muon_lr_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._muon_wd_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._muon_beta2_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        
        # Compile conditionally
        compiler_kwargs = {"dynamic": False, "fullgraph": True}
        if device_type in ("cuda", "cpu"):
            self.adamw_step_fused = torch.compile(adamw_step_fused, **compiler_kwargs)
            self.muon_step_fused = torch.compile(muon_step_fused, **compiler_kwargs)
        else:
            self.adamw_step_fused = adamw_step_fused
            self.muon_step_fused = muon_step_fused

    def _step_adamw(self, group):
        for p in group['params']:
            if p.grad is None:
                continue
            grad = p.grad
            state = self.state[p]
            if not state:
                state['step'] = 0
                state['exp_avg'] = torch.zeros_like(p)
                state['exp_avg_sq'] = torch.zeros_like(p)
            state['step'] += 1
            self._adamw_step_t.fill_(state['step'])
            self._adamw_lr_t.fill_(group['lr'])
            self._adamw_beta1_t.fill_(group['betas'][0])
            self._adamw_beta2_t.fill_(group['betas'][1])
            self._adamw_eps_t.fill_(group['eps'])
            self._adamw_wd_t.fill_(group['weight_decay'])
            self.adamw_step_fused(p, grad, state['exp_avg'], state['exp_avg_sq'],
                            self._adamw_step_t, self._adamw_lr_t, self._adamw_beta1_t,
                            self._adamw_beta2_t, self._adamw_eps_t, self._adamw_wd_t)

    def _step_muon(self, group):
        params = group['params']
        if not params:
            return
        p = params[0]
        state = self.state[p]
        num_params = len(params)
        shape, device, dtype = p.shape, p.device, p.dtype
        if "momentum_buffer" not in state:
            state["momentum_buffer"] = torch.zeros(num_params, *shape, dtype=dtype, device=device)
        if "second_momentum_buffer" not in state:
            state_shape = (num_params, shape[-2], 1) if shape[-2] >= shape[-1] else (num_params, 1, shape[-1])
            state["second_momentum_buffer"] = torch.zeros(state_shape, dtype=dtype, device=device)
        red_dim = -1 if shape[-2] >= shape[-1] else -2
        stacked_grads = torch.stack([p.grad for p in params])
        stacked_params = torch.stack(params)
        self._muon_momentum_t.fill_(group["momentum"])
        self._muon_beta2_t.fill_(group["beta2"] if group["beta2"] is not None else 0.0)
        self._muon_lr_t.fill_(group["lr"] * max(1.0, shape[-2] / shape[-1])**0.5)
        self._muon_wd_t.fill_(group["weight_decay"])
        self.muon_step_fused(stacked_grads, stacked_params,
                        state["momentum_buffer"], state["second_momentum_buffer"],
                        self._muon_momentum_t, self._muon_lr_t, self._muon_wd_t,
                        self._muon_beta2_t, group["ns_steps"], red_dim)
        torch._foreach_copy_(params, list(stacked_params.unbind(0)))

    @torch.no_grad()
    def step(self):
        for group in self.param_groups:
            if group['kind'] == 'adamw':
                self._step_adamw(group)
            elif group['kind'] == 'muon':
                self._step_muon(group)

# ---------------------------------------------------------------------------
# Hyperparameters (edit these directly, no CLI flags needed)
# ---------------------------------------------------------------------------

ORCHESTRATION_METADATA = {
    "run_id": env_str("AUTORESEARCH_RUN_ID", f"run-{int(time.time())}"),
    "direction_id": env_str("AUTORESEARCH_DIRECTION_ID", ""),
    "direction_slug": env_str("AUTORESEARCH_DIRECTION_SLUG", ""),
    "scheduled_run_id": env_str("AUTORESEARCH_SCHEDULED_RUN_ID", ""),
    "mode": env_str("AUTORESEARCH_MODE", ""),
    "branch_target": env_str("AUTORESEARCH_BRANCH_TARGET", ""),
}

# Model architecture
ASPECT_RATIO = env_int("AUTORESEARCH_ASPECT_RATIO", 64)        # model_dim = depth * ASPECT_RATIO
HEAD_DIM = env_int("AUTORESEARCH_HEAD_DIM", 128)               # target head dimension for attention
WINDOW_PATTERN = env_str("AUTORESEARCH_WINDOW_PATTERN", "L")   # sliding window pattern: L=full, S=half context

# Optimization
TOTAL_BATCH_SIZE = env_int("AUTORESEARCH_TOTAL_BATCH_SIZE", 2**16)  # ~65K tokens per optimizer step
EMBEDDING_LR = env_float("AUTORESEARCH_EMBEDDING_LR", 0.6)          # learning rate for token embeddings (Adam)
UNEMBEDDING_LR = env_float("AUTORESEARCH_UNEMBEDDING_LR", 0.004)    # learning rate for lm_head (Adam)
MATRIX_LR = env_float("AUTORESEARCH_MATRIX_LR", 0.04)               # learning rate for matrix parameters (Muon)
SCALAR_LR = env_float("AUTORESEARCH_SCALAR_LR", 0.5)                # learning rate for per-layer scalars (Adam)
WEIGHT_DECAY = env_float("AUTORESEARCH_WEIGHT_DECAY", 0.2)          # cautious weight decay for Muon
ADAM_BETAS = (
    env_float("AUTORESEARCH_ADAM_BETA1", 0.8),
    env_float("AUTORESEARCH_ADAM_BETA2", 0.95),
)
WARMUP_RATIO = env_float("AUTORESEARCH_WARMUP_RATIO", 0.0)          # fraction of time budget for LR warmup
WARMDOWN_RATIO = env_float("AUTORESEARCH_WARMDOWN_RATIO", 0.5)      # fraction of time budget for LR warmdown
FINAL_LR_FRAC = env_float("AUTORESEARCH_FINAL_LR_FRAC", 0.0)        # final LR as fraction of initial

# Model size
DEPTH = env_int("AUTORESEARCH_DEPTH", 4)                            # number of transformer layers
DEVICE_BATCH_SIZE = env_int("AUTORESEARCH_DEVICE_BATCH_SIZE", 16)   # per-device batch size (reduce if OOM)
TRAIN_TIME_BUDGET = env_int("AUTORESEARCH_TIME_BUDGET", TIME_BUDGET)
WARMUP_STEPS = env_int("AUTORESEARCH_WARMUP_STEPS", 10)
EVAL_TOKENS_OVERRIDE = env_int("AUTORESEARCH_EVAL_TOKENS", 0)
PROGRESS_EVENT_INTERVAL_SECONDS = env_int("AUTORESEARCH_PROGRESS_INTERVAL_SECONDS", 30)
RUN_EVENTS_PATH = env_str("AUTORESEARCH_EVENT_LOG", "run-events.jsonl")
RUN_FINAL_PATH = env_str("AUTORESEARCH_FINAL_RECORD", "run-final.json")

SUPPORTED_ENV_VARS = {
    "orchestration": {
        "AUTORESEARCH_RUN_ID": "Unique runtime identifier for this run.",
        "AUTORESEARCH_DIRECTION_ID": "Selected community direction id.",
        "AUTORESEARCH_DIRECTION_SLUG": "Human-readable direction slug.",
        "AUTORESEARCH_SCHEDULED_RUN_ID": "Orchestrator-level scheduled run id.",
        "AUTORESEARCH_MODE": "Execution mode such as explore or exploit.",
        "AUTORESEARCH_BRANCH_TARGET": "Target branch or lineage reference.",
    },
    "controls": {
        "AUTORESEARCH_TIME_BUDGET": "Training time budget in seconds.",
        "AUTORESEARCH_WARMUP_STEPS": "Warmup steps excluded from budget accounting.",
        "AUTORESEARCH_EVAL_TOKENS": "Override validation token budget.",
        "AUTORESEARCH_TOTAL_BATCH_SIZE": "Total batch size in tokens per optimizer step.",
        "AUTORESEARCH_DEVICE_BATCH_SIZE": "Per-device batch size.",
        "AUTORESEARCH_DEPTH": "Transformer depth.",
        "AUTORESEARCH_ASPECT_RATIO": "Width scaling factor used to derive model dimension.",
        "AUTORESEARCH_HEAD_DIM": "Attention head dimension target.",
        "AUTORESEARCH_WINDOW_PATTERN": "Attention window pattern, e.g. L or S.",
        "AUTORESEARCH_EMBEDDING_LR": "Embedding learning rate.",
        "AUTORESEARCH_UNEMBEDDING_LR": "Unembedding learning rate.",
        "AUTORESEARCH_MATRIX_LR": "Matrix parameter learning rate.",
        "AUTORESEARCH_SCALAR_LR": "Scalar learning rate.",
        "AUTORESEARCH_WEIGHT_DECAY": "Weight decay schedule starting value.",
        "AUTORESEARCH_ADAM_BETA1": "Adam beta1.",
        "AUTORESEARCH_ADAM_BETA2": "Adam beta2.",
        "AUTORESEARCH_WARMUP_RATIO": "LR warmup ratio.",
        "AUTORESEARCH_WARMDOWN_RATIO": "LR warmdown ratio.",
        "AUTORESEARCH_FINAL_LR_FRAC": "Final LR fraction after warmdown.",
        "AUTORESEARCH_PROGRESS_INTERVAL_SECONDS": "NDJSON progress event emission interval.",
        "AUTORESEARCH_EVENT_LOG": "Path to JSONL event log output.",
        "AUTORESEARCH_FINAL_RECORD": "Path to final JSON run record output.",
    },
}

if EVAL_TOKENS_OVERRIDE > 0:
    prepare_module.EVAL_TOKENS = EVAL_TOKENS_OVERRIDE

def build_model_config(depth):
    tokenizer = Tokenizer.from_directory()
    vocab_size = tokenizer.get_vocab_size()
    base_dim = depth * ASPECT_RATIO
    model_dim = ((base_dim + HEAD_DIM - 1) // HEAD_DIM) * HEAD_DIM
    num_heads = model_dim // HEAD_DIM
    return tokenizer, GPTConfig(
        sequence_len=MAX_SEQ_LEN, vocab_size=vocab_size,
        n_layer=depth, n_head=num_heads, n_kv_head=num_heads, n_embd=model_dim,
        window_pattern=WINDOW_PATTERN,
    )

# Schedules (all based on progress = training_time / TIME_BUDGET)

def get_lr_multiplier(progress):
    if progress < WARMUP_RATIO:
        return progress / WARMUP_RATIO if WARMUP_RATIO > 0 else 1.0
    elif progress < 1.0 - WARMDOWN_RATIO:
        return 1.0
    else:
        cooldown = (1.0 - progress) / WARMDOWN_RATIO
        return cooldown * 1.0 + (1 - cooldown) * FINAL_LR_FRAC

def get_muon_momentum(step):
    frac = min(step / 300, 1)
    return (1 - frac) * 0.85 + frac * 0.95

def get_weight_decay(progress):
    return WEIGHT_DECAY * (1 - progress)

def sync_device(device_type):
    if device_type == "cuda":
        torch.cuda.synchronize()
    elif device_type == "mps":
        torch.mps.synchronize()


def collect_controls():
    return {
        "time_budget": TRAIN_TIME_BUDGET,
        "warmup_steps": WARMUP_STEPS,
        "eval_tokens": prepare_module.EVAL_TOKENS,
        "total_batch_size": TOTAL_BATCH_SIZE,
        "device_batch_size": DEVICE_BATCH_SIZE,
        "depth": DEPTH,
        "aspect_ratio": ASPECT_RATIO,
        "head_dim": HEAD_DIM,
        "window_pattern": WINDOW_PATTERN,
        "embedding_lr": EMBEDDING_LR,
        "unembedding_lr": UNEMBEDDING_LR,
        "matrix_lr": MATRIX_LR,
        "scalar_lr": SCALAR_LR,
        "weight_decay": WEIGHT_DECAY,
        "adam_betas": list(ADAM_BETAS),
        "warmup_ratio": WARMUP_RATIO,
        "warmdown_ratio": WARMDOWN_RATIO,
        "final_lr_frac": FINAL_LR_FRAC,
        "progress_interval_seconds": PROGRESS_EVENT_INTERVAL_SECONDS,
    }


def collect_artifact_paths():
    return {
        "run_events_path": str(Path(RUN_EVENTS_PATH).resolve()),
        "run_final_path": str(Path(RUN_FINAL_PATH).resolve()),
    }


def format_error(exc):
    return {
        "error_type": type(exc).__name__,
        "message": str(exc),
    }


def main():
    global device_type

    artifact_writer = RunArtifactWriter(
        metadata=ORCHESTRATION_METADATA,
        controls=collect_controls(),
        artifact_paths=collect_artifact_paths(),
    )

    t_start = time.time()
    step = 0
    last_progress_event_at = 0.0

    try:
        torch.manual_seed(42)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(42)
        torch.set_float32_matmul_precision("high")

        device_type = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        device = torch.device(device_type)

        if device_type == "cuda":
            autocast_ctx = torch.amp.autocast(device_type="cuda", dtype=torch.bfloat16)
        elif device_type == "cpu":
            autocast_ctx = torch.amp.autocast(device_type="cpu", dtype=torch.bfloat16)
        else:
            import contextlib
            autocast_ctx = contextlib.nullcontext()

        H100_BF16_PEAK_FLOPS = 989.5e12

        tokenizer, config = build_model_config(DEPTH)
        vocab_size = tokenizer.get_vocab_size()
        print(f"Vocab size: {vocab_size:,}")
        print(f"Model config: {asdict(config)}")

        with torch.device("meta"):
            model = GPT(config)
        model.to_empty(device=device)
        model.init_weights()

        param_counts = model.num_scaling_params()
        print("Parameter counts:")
        for key, value in param_counts.items():
            print(f"  {key:24s}: {value:,}")
        num_params = param_counts['total']
        num_flops_per_token = model.estimate_flops()
        print(f"Estimated FLOPs per token: {num_flops_per_token:e}")

        tokens_per_fwdbwd = DEVICE_BATCH_SIZE * MAX_SEQ_LEN
        assert TOTAL_BATCH_SIZE % tokens_per_fwdbwd == 0
        grad_accum_steps = TOTAL_BATCH_SIZE // tokens_per_fwdbwd

        optimizer = model.setup_optimizer(
            unembedding_lr=UNEMBEDDING_LR,
            embedding_lr=EMBEDDING_LR,
            scalar_lr=SCALAR_LR,
            adam_betas=ADAM_BETAS,
            matrix_lr=MATRIX_LR,
            weight_decay=WEIGHT_DECAY,
        )

        if device_type == "cuda":
            model = torch.compile(model, dynamic=False)

        train_loader = make_dataloader(tokenizer, DEVICE_BATCH_SIZE, MAX_SEQ_LEN, "train")
        x, y, epoch = next(train_loader)

        print(f"Time budget: {TRAIN_TIME_BUDGET}s")
        print(f"Warmup steps excluded from budget: {WARMUP_STEPS}")
        print(f"Gradient accumulation steps: {grad_accum_steps}")
        print("Supported env vars:")
        print(json.dumps(SUPPORTED_ENV_VARS, indent=2, sort_keys=True))

        artifact_writer.emit_event(
            event="run_start",
            status="running",
            step=step,
            metrics={
                "time_budget": TRAIN_TIME_BUDGET,
                "grad_accum_steps": grad_accum_steps,
                "device_type": device_type,
                "num_params_M": round(num_params / 1e6, 6),
            },
            extra={
                "controls": collect_controls(),
                "artifact_paths": collect_artifact_paths(),
            },
        )

        t_start_training = time.time()
        smooth_train_loss = 0
        total_training_time = 0

        while True:
            sync_device(device_type)
            t0 = time.time()
            for _ in range(grad_accum_steps):
                with autocast_ctx:
                    loss = model(x, y)
                train_loss = loss.detach()
                loss = loss / grad_accum_steps
                loss.backward()
                x, y, epoch = next(train_loader)

            progress = min(total_training_time / TRAIN_TIME_BUDGET, 1.0)
            lrm = get_lr_multiplier(progress)
            muon_momentum = get_muon_momentum(step)
            muon_weight_decay = get_weight_decay(progress)
            for group in optimizer.param_groups:
                group["lr"] = group["initial_lr"] * lrm
                if group['kind'] == 'muon':
                    group["momentum"] = muon_momentum
                    group["weight_decay"] = muon_weight_decay
            optimizer.step()
            model.zero_grad(set_to_none=True)

            train_loss_f = train_loss.item()
            if train_loss_f > 100:
                raise RuntimeError("Training loss exploded above 100")

            sync_device(device_type)
            t1 = time.time()
            dt = t1 - t0

            if step >= WARMUP_STEPS:
                total_training_time += dt

            ema_beta = 0.9
            smooth_train_loss = ema_beta * smooth_train_loss + (1 - ema_beta) * train_loss_f
            debiased_smooth_loss = smooth_train_loss / (1 - ema_beta**(step + 1))
            pct_done = 100 * progress
            tok_per_sec = int(TOTAL_BATCH_SIZE / dt)
            mfu = 100 * num_flops_per_token * TOTAL_BATCH_SIZE / dt / H100_BF16_PEAK_FLOPS
            remaining = max(0, TRAIN_TIME_BUDGET - total_training_time)

            print(f"\rstep {step:05d} ({pct_done:.1f}%) | loss: {debiased_smooth_loss:.6f} | lrm: {lrm:.2f} | dt: {dt*1000:.0f}ms | tok/sec: {tok_per_sec:,} | mfu: {mfu:.1f}% | epoch: {epoch} | remaining: {remaining:.0f}s    ", end="", flush=True)

            now = time.time()
            if step == 0 or now - last_progress_event_at >= PROGRESS_EVENT_INTERVAL_SECONDS:
                artifact_writer.emit_event(
                    event="run_progress",
                    status="running",
                    step=step,
                    metrics={
                        "loss": round(debiased_smooth_loss, 6),
                        "training_seconds": round(total_training_time, 3),
                        "progress_percent": round(pct_done, 3),
                        "tok_per_sec": tok_per_sec,
                        "mfu_percent": round(mfu, 4),
                        "epoch": epoch,
                    },
                )
                last_progress_event_at = now

            if step == 0:
                gc.collect()
                gc.freeze()
                gc.disable()
            elif (step + 1) % 5000 == 0:
                gc.collect()

            step += 1
            if step >= WARMUP_STEPS and total_training_time >= TRAIN_TIME_BUDGET:
                break

        print()

        total_tokens = step * TOTAL_BATCH_SIZE
        model.eval()
        with autocast_ctx:
            val_bpb = evaluate_bpb(model, tokenizer, DEVICE_BATCH_SIZE)

        artifact_writer.emit_event(
            event="run_eval",
            status="running",
            step=step,
            metrics={
                "val_bpb": round(val_bpb, 6),
                "training_seconds": round(total_training_time, 3),
                "total_tokens_M": round(total_tokens / 1e6, 6),
            },
        )

        t_end = time.time()
        steady_state_steps = max(step - WARMUP_STEPS, 0)
        steady_state_mfu = 100 * num_flops_per_token * TOTAL_BATCH_SIZE * steady_state_steps / total_training_time / H100_BF16_PEAK_FLOPS if total_training_time > 0 else 0
        if device_type == "cuda":
            peak_vram_mb = torch.cuda.max_memory_allocated() / 1024 / 1024
        else:
            peak_vram_mb = 0.0

        final_metrics = {
            "val_bpb": round(val_bpb, 6),
            "training_seconds": round(total_training_time, 1),
            "total_seconds": round(t_end - t_start, 1),
            "peak_vram_mb": round(peak_vram_mb, 1),
            "mfu_percent": round(steady_state_mfu, 2),
            "total_tokens_M": round(total_tokens / 1e6, 1),
            "num_steps": step,
            "num_params_M": round(num_params / 1e6, 1),
            "depth": DEPTH,
        }

        print("---")
        print(f"val_bpb:          {final_metrics['val_bpb']:.6f}")
        print(f"training_seconds: {final_metrics['training_seconds']:.1f}")
        print(f"total_seconds:    {final_metrics['total_seconds']:.1f}")
        print(f"peak_vram_mb:     {final_metrics['peak_vram_mb']:.1f}")
        print(f"mfu_percent:      {final_metrics['mfu_percent']:.2f}")
        print(f"total_tokens_M:   {final_metrics['total_tokens_M']:.1f}")
        print(f"num_steps:        {final_metrics['num_steps']}")
        print(f"num_params_M:     {final_metrics['num_params_M']:.1f}")
        print(f"depth:            {final_metrics['depth']}")

        artifact_writer.emit_event(
            event="run_finish",
            status="finished",
            step=step,
            metrics=final_metrics,
        )
        artifact_writer.write_final_record(status="finished", metrics=final_metrics)
        return 0

    except Exception as exc:
        error = format_error(exc)
        artifact_writer.emit_event(
            event="run_failure",
            status="failed",
            step=step,
            metrics={},
            extra=error,
        )
        artifact_writer.write_final_record(status="failed", metrics={}, error=error)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
