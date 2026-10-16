window.addEventListener('DOMContentLoaded', () => {
            const qrImage = document.getElementById('qrImage');
            if (qrImage) {
                let currentUrl = window.location.href;
                if (currentUrl.startsWith('file://')) {
                    currentUrl = 'https://github.com/TenCuaThay/DaoDongKy'; 
                }
                qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(currentUrl)}`;
            }
        });

        const startButton = document.getElementById('startButton');
        const pauseButton = document.getElementById('pauseButton');
        const resetButton = document.getElementById('resetButton');
        const saveButton = document.getElementById('saveButton');
        const fullscreenButton = document.getElementById('fullscreenButton');
        const infoText = document.getElementById('infoText');
        const micSelect = document.getElementById('micSelect');
        const speedSelect = document.getElementById('speedSelect');
        const modeSelect = document.getElementById('modeSelect');
        const canvas = document.getElementById('oscilloscope');
        const canvasCtx = canvas.getContext('2d');
        
        let audioCtx, processor, dummyGain;
        let highpassFilter, lowpassFilter;
        let currentStream = null;
        let audioSource = null;
        
        let isPaused = true; 
        let isContinuousMode = false; 
        let sampleRate = 48000; 
        let stopTimer; 

        let recordedData;
        let recordIndex = 0;

        let detectedFrequency = 0;
        let lastCorrelateTime = 0;
        let isUserZoomed = false; 

        let totalTimeOnScreen = 5 * (1.0 / 440); 
        let currentZoomY = 2.0;

        let targetFPS = 60; 
        let lastDrawTime = performance.now();
        
        // --- THUẬT TOÁN CHỐNG ĐƠ KHI CHUYỂN ỨNG DỤNG (TAB) ---
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && !isPaused) {
                // Tự động tạm dừng nếu người dùng ẩn web đi
                isPaused = true;
                clearTimeout(stopTimer);
                pauseButton.textContent = "2. Đo / Dừng";
                pauseButton.style.backgroundColor = "#28a745";
                infoText.textContent = "Đã tạm dừng do ẩn trang (Bấm Làm mới / Đo để tiếp tục)";
                infoText.style.color = "#d93025";
            }
        });
        // ------------------------------------------------------

        speedSelect.addEventListener('change', (e) => {
            if (e.target.value === 'slow') {
                targetFPS = 10; 
            } else {
                targetFPS = 60; 
            }
        });

        modeSelect.addEventListener('change', (e) => {
            isContinuousMode = (e.target.value === 'continuous');
            if (isContinuousMode) {
                speedSelect.style.display = 'block';
            } else {
                speedSelect.style.display = 'none';
                targetFPS = 60; 
                speedSelect.value = "fast"; 
            }
        });
        
        function resizeCanvas() {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
            drawFrame(); 
        }
        window.addEventListener('resize', resizeCanvas);

        let initialPinchDistX = 0;
        let initialPinchDistY = 0;
        let startDuration = totalTimeOnScreen;
        let startZoomY = currentZoomY;

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                if (!isPaused) return; 

                let dx = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
                let dy = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
                initialPinchDistX = Math.max(dx, 10); 
                initialPinchDistY = Math.max(dy, 10);
                startDuration = totalTimeOnScreen;
                startZoomY = currentZoomY;
            }
        }, {passive: false});

        canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                if (!isPaused) return;

                let dx = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
                let dy = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
                dx = Math.max(dx, 10);
                dy = Math.max(dy, 10);

                isUserZoomed = true; 
                totalTimeOnScreen = startDuration * (initialPinchDistX / dx); 
                currentZoomY = startZoomY * (dy / initialPinchDistY);

                totalTimeOnScreen = Math.max(0.002, Math.min(totalTimeOnScreen, 2.4));
                currentZoomY = Math.max(0.5, Math.min(currentZoomY, 10.0));

                if (isPaused) drawFrame();
            }
        }, {passive: false});

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!isPaused) return;

            isUserZoomed = true;
            if (e.deltaY > 0) { 
                totalTimeOnScreen *= 1.1; currentZoomY /= 1.1;      
            } else { 
                totalTimeOnScreen /= 1.1; currentZoomY *= 1.1;      
            }
            
            totalTimeOnScreen = Math.max(0.002, Math.min(totalTimeOnScreen, 2.4));
            currentZoomY = Math.max(0.5, Math.min(currentZoomY, 10.0));
            
            if (isPaused) drawFrame();
        }, {passive: false});

        fullscreenButton.addEventListener('click', () => {
            let elem = document.documentElement;
            let isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;

            if (!isFullscreen) {
                if (elem.requestFullscreen) elem.requestFullscreen().catch(() => alert("Xoay ngang điện thoại nhé!"));
                else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
                else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
            } else {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                else if (document.msExitFullscreen) document.msExitFullscreen();
            }
        });

        function updateFullscreenButton() {
            let isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
            fullscreenButton.textContent = !isFullscreen ? "5. Toàn màn hình" : "5. Thu nhỏ";
            setTimeout(resizeCanvas, 100); 
        }

        document.addEventListener('fullscreenchange', updateFullscreenButton);
        document.addEventListener('webkitfullscreenchange', updateFullscreenButton);

        function autoCorrelate(buffer, sampleRate) {
            let SIZE = buffer.length;
            let sumSq = 0;
            for (let i = 0; i < SIZE; i++) {
                let val = buffer[i];
                sumSq += val * val;
            }
            let rootMeanSq = Math.sqrt(sumSq / SIZE);
            if (rootMeanSq < 0.02) return -1; 

            let c = new Array(SIZE).fill(0);
            for (let i = 0; i < SIZE / 2; i++) {
                for (let j = 0; j < SIZE - i; j++) {
                    c[i] += buffer[j] * buffer[j + i];
                }
            }

            let d = 0;
            while (c[d] > c[d + 1] && d < SIZE / 2) d++;
            let maxval = -1, maxpos = -1;
            for (let i = d; i < SIZE / 2; i++) {
                if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
            }
            
            if (maxpos <= 0) return -1;
            let freq = sampleRate / maxpos;
            if (freq < 100 || freq > 1500) return -1; 
            return freq;
        }

        function triggerAutoStop() {
            clearTimeout(stopTimer);
            if (!isPaused && !isContinuousMode) {
                stopTimer = setTimeout(() => {
                    if (!isPaused) {
                        isPaused = true;
                        pauseButton.textContent = "2. Đo / Dừng";
                        pauseButton.style.backgroundColor = "#28a745"; 
                        infoText.textContent = "Đã đo xong - Ấn nút 'Đo / Dừng' để tiếp tục";
                        infoText.style.color = "#d93025";
                    }
                }, 2000); 
            }
        }

        async function initAudio(deviceId = null) {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                sampleRate = audioCtx.sampleRate; 
                recordedData = new Float32Array(sampleRate * 3); 
                
                highpassFilter = audioCtx.createBiquadFilter();
                highpassFilter.frequency.value = 80;
                highpassFilter.type = 'highpass';

                lowpassFilter = audioCtx.createBiquadFilter();
                lowpassFilter.frequency.value = 3000;
                lowpassFilter.type = 'lowpass';

                processor = audioCtx.createScriptProcessor(4096, 1, 1);
                processor.onaudioprocess = function(e) {
                    if (!isPaused) {
                        let input = e.inputBuffer.getChannelData(0);
                        for (let i = 0; i < input.length; i++) {
                            recordedData[recordIndex % recordedData.length] = input[i];
                            recordIndex++;
                        }
                    }
                };

                dummyGain = audioCtx.createGain();
                dummyGain.gain.value = 0;
                
                highpassFilter.connect(lowpassFilter);
                lowpassFilter.connect(processor);
                processor.connect(dummyGain);
                dummyGain.connect(audioCtx.destination);
            }

            try {
                if (currentStream) {
                    currentStream.getTracks().forEach(track => track.stop());
                }
                if (audioSource) {
                    audioSource.disconnect();
                }

                const constraints = {
                    audio: deviceId ? { deviceId: { exact: deviceId } } : true
                };
                
                currentStream = await navigator.mediaDevices.getUserMedia(constraints);
                audioSource = audioCtx.createMediaStreamSource(currentStream);
                audioSource.connect(highpassFilter);

                isPaused = true;
                resizeCanvas();
                drawFrame(true); 
                
                startButton.textContent = "Đã kết nối";
                startButton.disabled = true;
                pauseButton.disabled = false;
                resetButton.disabled = false;
                saveButton.disabled = false;
                
                infoText.textContent = "Trạng thái: Đã sẵn sàng";
                infoText.style.color = "#007bff";

                if (!deviceId) {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const audioInputs = devices.filter(device => device.kind === 'audioinput');
                    
                    micSelect.innerHTML = ''; 
                    audioInputs.forEach((device, index) => {
                        const option = document.createElement('option');
                        option.value = device.deviceId;
                        option.text = device.label || `Microphone ${index + 1}`;
                        micSelect.appendChild(option);
                    });
                    
                    document.getElementById('settingsRow').style.display = 'flex';
                    if (audioInputs.length > 1) {
                        micSelect.style.display = 'block';
                    } else {
                        micSelect.style.display = 'none';
                    }
                }
            } catch (err) {
                alert("Không thể truy cập micro. Lỗi: " + err);
            }
        }

        startButton.addEventListener('click', () => initAudio());

        micSelect.addEventListener('change', (e) => {
            initAudio(e.target.value); 
            isPaused = true;
            clearTimeout(stopTimer); 
            pauseButton.textContent = "2. Đo / Dừng";
            pauseButton.style.backgroundColor = "#28a745"; 
            infoText.textContent = `Đã chuyển sang: ${e.target.options[e.target.selectedIndex].text}`;
            recordIndex = 0;
            recordedData.fill(0);
            drawFrame(true);
        });

        pauseButton.addEventListener('click', () => {
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            if (isPaused) {
                isPaused = false;
                recordIndex = 0; 
                recordedData.fill(0);
                
                isUserZoomed = false; 
                detectedFrequency = 0;

                pauseButton.textContent = "Đang đo...";
                pauseButton.style.backgroundColor = "#dc3545"; 
                
                infoText.textContent = isContinuousMode ? "Khảo sát nguồn âm (Đang thu...)" : "Khảo sát tần số (Quét Live)...";
                infoText.style.color = "#dc3545";
                
                lastDrawTime = performance.now(); 
                draw(); 
                triggerAutoStop(); 
            } else {
                isPaused = true;
                clearTimeout(stopTimer); 
                pauseButton.textContent = "2. Đo / Dừng";
                pauseButton.style.backgroundColor = "#28a745"; 
                infoText.textContent = isContinuousMode ? "Đã tạm dừng đồ thị" : "Đã đo xong - Ấn nút 'Đo / Dừng' để tiếp tục";
                infoText.style.color = "#d93025";
            }
        });

        resetButton.addEventListener('click', () => {
            isPaused = true;
            clearTimeout(stopTimer); 
            pauseButton.textContent = "2. Đo / Dừng";
            pauseButton.style.backgroundColor = "#28a745"; 
            
            // --- NÂNG CẤP: ÉP ĐÁNH THỨC PHẦN CỨNG NẾU BỊ ĐƠ ---
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            lastDrawTime = performance.now(); 
            // --------------------------------------------------

            recordIndex = 0;
            recordedData.fill(0);
            
            isUserZoomed = false;
            detectedFrequency = 0;
            totalTimeOnScreen = 5 * (1.0 / 440); 
            currentZoomY = 2.0; 
            
            infoText.textContent = "Sẵn sàng (Bấm 'Đo / Dừng' để tiếp tục)";
            infoText.style.color = "#007bff";
            
            drawFrame(true); 
        });

        saveButton.addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = `DoThi_SongAm.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        });

        function drawFrame(isReset = false) {
            if (!audioCtx) {
                canvasCtx.fillStyle = '#e6f7ff'; 
                canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
                return;
            }

            if (!isPaused && recordIndex > 2048) {
                let now = Date.now();
                if (now - lastCorrelateTime > 300) {
                    let recentData = new Float32Array(2048);
                    for(let i=0; i<2048; i++) {
                        recentData[i] = recordedData[(recordIndex - 2048 + i) % recordedData.length];
                    }
                    let freq = autoCorrelate(recentData, sampleRate);
                    if (freq > 0) detectedFrequency = freq;
                    lastCorrelateTime = now;
                }
            }

            if (!isUserZoomed) {
                let freqForCalc = (detectedFrequency > 0) ? detectedFrequency : 440;
                totalTimeOnScreen = 5 * (1.0 / freqForCalc);
                totalTimeOnScreen = Math.max(0.002, Math.min(totalTimeOnScreen, 2.4));
            }

            const zoomY = currentZoomY;

            canvasCtx.fillStyle = '#e6f7ff'; 
            canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

            canvasCtx.strokeStyle = '#b3e0ff'; 
            canvasCtx.lineWidth = 1;
            const stepGridX = canvas.width / 10;  
            const stepGridY = canvas.height / 8;  
            
            canvasCtx.beginPath();
            for(let i = 0; i <= 10; i++) {
                canvasCtx.moveTo(i * stepGridX, 0); canvasCtx.lineTo(i * stepGridX, canvas.height);
            }
            for(let i = 0; i <= 8; i++) {
                canvasCtx.moveTo(0, i * stepGridY); canvasCtx.lineTo(canvas.width, i * stepGridY);
            }
            canvasCtx.stroke();

            canvasCtx.lineWidth = 2;
            canvasCtx.strokeStyle = '#000000'; 
            canvasCtx.beginPath();
            canvasCtx.moveTo(0, canvas.height / 2); 
            canvasCtx.lineTo(canvas.width, canvas.height / 2);
            canvasCtx.moveTo(canvas.width / 2, 0);  
            canvasCtx.lineTo(canvas.width / 2, canvas.height);
            
            const tickSize = 5; 
            for(let i = 0; i <= 10; i++) {
                canvasCtx.moveTo(i * stepGridX, canvas.height / 2 - tickSize);
                canvasCtx.lineTo(i * stepGridX, canvas.height / 2 + tickSize);
            }
            for(let i = 0; i <= 8; i++) {
                canvasCtx.moveTo(canvas.width / 2 - tickSize, i * stepGridY);
                canvasCtx.lineTo(canvas.width / 2 + tickSize, i * stepGridY);
            }
            canvasCtx.stroke();

            canvasCtx.fillStyle = '#000000'; 
            canvasCtx.font = 'bold 13px Arial';
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'top';
            let timePerGrid = totalTimeOnScreen / 10;
            for(let i = 0; i <= 10; i++) {
                if (i !== 5) { 
                    let t_val = (i - 5) * timePerGrid;
                    let ms = t_val * 1000;
                    let t_str = parseFloat(ms.toFixed(2)).toString().replace('.', ','); 
                    canvasCtx.fillText(t_str, i * stepGridX, canvas.height / 2 + 10);
                }
            }
            canvasCtx.textAlign = 'right';
            canvasCtx.fillText("t (ms)", canvas.width - 10, canvas.height / 2 - 25);
            
            canvasCtx.textAlign = 'left';
            canvasCtx.textBaseline = 'middle';
            const maxY = 1.0 / zoomY; 
            const valPerStep = (maxY * 2) / 8; 
            for(let i = 0; i <= 8; i++) {
                if (i !== 4 && i !== 0) { 
                    let val = maxY - (i * valPerStep);
                    let val_str = parseFloat(val.toFixed(2)).toString().replace('.', ',');
                    canvasCtx.fillText(val_str, canvas.width / 2 + 10, i * stepGridY);
                }
            }
            canvasCtx.fillText("0", canvas.width / 2 + 8, canvas.height / 2 + 15); 
            canvasCtx.textBaseline = 'top';
            canvasCtx.fillText("Biên độ", canvas.width / 2 + 10, 10);

            if (isReset) return;

            if (recordIndex > 0) {
                canvasCtx.save(); 
                canvasCtx.beginPath();
                canvasCtx.rect(0, 0, canvas.width, canvas.height);
                canvasCtx.clip(); 

                canvasCtx.lineWidth = 3; 
                canvasCtx.strokeStyle = '#ff0000'; 
                canvasCtx.beginPath();

                const samplesNeeded = Math.floor(totalTimeOnScreen * sampleRate);
                
                const step = Math.max(1, Math.floor(samplesNeeded / (canvas.width * 2))); 
                const sliceWidth = (canvas.width / samplesNeeded) * step;
                
                let x = 0;
                let hasMoved = false;

                const startIndex = recordIndex - samplesNeeded;
                const endIndex = startIndex + samplesNeeded;

                for (let i = startIndex; i < endIndex; i += step) {
                    if (i < 0 || i >= recordIndex) {
                        x += sliceWidth;
                        continue;
                    }

                    let v = recordedData[i % recordedData.length];

                    if (step > 2) {
                        let maxV = v;
                        let minV = v;
                        for(let j = 1; j < step; j++) {
                            if (i + j < recordIndex) {
                                let tempV = recordedData[(i + j) % recordedData.length];
                                if (tempV > maxV) maxV = tempV;
                                if (tempV < minV) minV = tempV;
                            }
                        }
                        
                        let yMin = (minV * -1.0) * zoomY * (canvas.height / 2) + (canvas.height / 2);
                        if (!hasMoved) { canvasCtx.moveTo(x, yMin); hasMoved = true; } 
                        else { canvasCtx.lineTo(x, yMin); }
                        
                        let yMax = (maxV * -1.0) * zoomY * (canvas.height / 2) + (canvas.height / 2);
                        canvasCtx.lineTo(x, yMax);
                        
                        x += sliceWidth;
                    } else {
                        let y = (v * -1.0) * zoomY * (canvas.height / 2) + (canvas.height / 2);
                        if (!hasMoved) { canvasCtx.moveTo(x, y); hasMoved = true; } 
                        else { canvasCtx.lineTo(x, y); }
                        x += sliceWidth;
                    }

                    if (x > canvas.width) break; 
                }
                
                canvasCtx.stroke();
                canvasCtx.restore(); 
            }
        }

        function draw(timestamp) {
            if (isPaused) return; 
            requestAnimationFrame(draw);

            if (!timestamp) timestamp = performance.now();
            let elapsed = timestamp - lastDrawTime;
            let interval = 1000 / targetFPS; 

            if (elapsed > interval) {
                lastDrawTime = timestamp - (elapsed % interval);
                drawFrame();
            }
        }
