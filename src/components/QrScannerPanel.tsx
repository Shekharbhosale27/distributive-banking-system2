import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CameraOff, CheckCircle2, QrCode, Upload, XCircle } from 'lucide-react';
import { ApiError, apiFetch, createIdempotencyKey, formatDateTime, formatInr } from '../lib/api';

interface QrScannerPanelProps {
  onPaymentComplete: () => void;
}

interface InspectedQr {
  token: string;
  recipientName: string;
  upiHandle: string;
  merchantAccountMasked: string;
  amountPaise: number | null;
  note: string | null;
  expiresAt: string;
}

export function QrScannerPanel({ onPaymentComplete }: QrScannerPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [rawPayload, setRawPayload] = useState('');
  const [inspected, setInspected] = useState<InspectedQr | null>(null);
  const [customAmountRupees, setCustomAmountRupees] = useState('');
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [receiptRef, setReceiptRef] = useState<string | null>(null);

  function stopCamera() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }

  useEffect(() => {
    return () => stopCamera();
  }, []);

  async function inspectPayload(payload: string) {
    setInspectError(null);
    setReceiptRef(null);
    try {
      const data = await apiFetch<InspectedQr>('/api/qr/inspect', {
        method: 'POST',
        body: JSON.stringify({ payload }),
      });
      setRawPayload(payload);
      setInspected(data);
      setCustomAmountRupees(data.amountPaise ? (data.amountPaise / 100).toFixed(2) : '');
    } catch (err) {
      setInspected(null);
      setInspectError(err instanceof ApiError ? err.message : 'Unable to validate QR payload.');
    }
  }

  async function startCamera() {
    setCameraError(null);
    setReceiptRef(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Device camera API is unavailable in this browser context. Upload a QR image or paste a QR payload below.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      setCameraActive(true);

      setTimeout(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        void videoRef.current.play();

        const scanFrame = () => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (!video || !canvas || !streamRef.current) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const decoded = jsQR(imageData.data, imageData.width, imageData.height);
              if (decoded?.data) {
                stopCamera();
                void inspectPayload(decoded.data);
                return;
              }
            }
          }
          rafRef.current = requestAnimationFrame(scanFrame);
        };
        rafRef.current = requestAnimationFrame(scanFrame);
      }, 100);
    } catch {
      setCameraError('Camera access denied or unavailable. Use QR image upload or paste the QR payload instead.');
    }
  }

  function handleImageUpload(file: File | undefined) {
    if (!file) return;
    setInspectError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = jsQR(imageData.data, imageData.width, imageData.height);
        if (!decoded?.data) {
          setInspectError('No valid QR code detected in the uploaded image.');
          return;
        }
        void inspectPayload(decoded.data);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  async function handleConfirmPay() {
    if (!inspected) return;
    setInspectError(null);
    const amountPaise = inspected.amountPaise ?? Math.round(Number(customAmountRupees) * 100);
    if (!amountPaise || amountPaise <= 0) {
      setInspectError('Enter a valid positive payment amount in INR.');
      return;
    }

    setPaying(true);
    try {
      const res = await apiFetch<{ transaction: { reference_code: string } }>('/api/qr/pay', {
        method: 'POST',
        body: JSON.stringify({
          payload: rawPayload,
          amountPaise,
          confirmed: true,
          idempotencyKey: createIdempotencyKey('qr'),
        }),
      });
      setReceiptRef(res.transaction.reference_code);
      setInspected(null);
      setRawPayload('');
      onPaymentComplete();
    } catch (err) {
      setInspectError(err instanceof ApiError ? err.message : 'QR payment failed.');
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        {!cameraActive ? (
          <button
            type="button"
            onClick={startCamera}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Camera className="w-4 h-4" />
            Scan with Camera
          </button>
        ) : (
          <button
            type="button"
            onClick={stopCamera}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <CameraOff className="w-4 h-4" />
            Stop Camera
          </button>
        )}

        <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors whitespace-nowrap shrink-0">
          <Upload className="w-4 h-4" />
          Upload QR Image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => handleImageUpload(e.target.files?.[0])}
          />
        </label>
      </div>

      {cameraError && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
          {cameraError}
        </div>
      )}

      {cameraActive && (
        <div className="relative rounded-xl overflow-hidden border border-slate-300 bg-slate-900 max-w-md">
          <video ref={videoRef} playsInline muted className="w-full h-64 object-cover" />
          <canvas ref={canvasRef} className="hidden" />
          <div className="p-2.5 bg-slate-900 text-xs text-slate-200 text-center">
            Point camera at a Meridian Trust Bank QR code. Scanning only previews details; you must confirm before paying.
          </div>
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-xs font-medium text-slate-700">Or Paste QR Payload String</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={rawPayload}
            onChange={(e) => setRawPayload(e.target.value)}
            placeholder="MERIDIAN_QR:..."
            className="flex-1 px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
          <button
            type="button"
            onClick={() => void inspectPayload(rawPayload)}
            disabled={!rawPayload.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <QrCode className="w-3.5 h-3.5" />
            Inspect QR
          </button>
        </div>
      </div>

      {inspectError && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {inspectError}
        </div>
      )}

      {receiptRef && (
        <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-emerald-900">QR Payment Authorized &amp; Settled</p>
            <p className="text-xs text-emerald-800 mt-0.5">
              Transaction Reference: <span className="font-mono font-semibold">{receiptRef}</span>
            </p>
          </div>
        </div>
      )}

      {inspected && (
        <div className="border border-slate-200 rounded-xl p-5 bg-slate-50 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-slate-500">Verified QR Payment Preview</p>
              <h3 className="text-base font-bold text-slate-900 mt-0.5">{inspected.recipientName}</h3>
              <p className="text-xs font-mono text-slate-600 mt-0.5">
                {inspected.upiHandle} · Account {inspected.merchantAccountMasked}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setInspected(null)}
              aria-label="Cancel QR preview"
              className="text-slate-400 hover:text-slate-600"
            >
              <XCircle className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-200">
            <div>
              <p className="text-xs text-slate-500">Amount to Pay</p>
              {inspected.amountPaise ? (
                <p className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                  {formatInr(inspected.amountPaise)}
                </p>
              ) : (
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={customAmountRupees}
                  onChange={(e) => setCustomAmountRupees(e.target.value)}
                  placeholder="Enter INR amount"
                  className="mt-1 w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              )}
            </div>
            <div>
              <p className="text-xs text-slate-500">Payment Note &amp; Expiry</p>
              <p className="text-sm text-slate-900 mt-1">{inspected.note || 'No note attached'}</p>
              <p className="text-xs text-slate-500 mt-0.5">Expires {formatDateTime(inspected.expiresAt)}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              disabled={paying}
              onClick={() => void handleConfirmPay()}
              className="px-5 py-2.5 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              {paying ? 'Authorizing Payment...' : 'Confirm & Pay'}
            </button>
            <button
              type="button"
              onClick={() => {
                setInspected(null);
                setInspectError(null);
              }}
              className="px-4 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
