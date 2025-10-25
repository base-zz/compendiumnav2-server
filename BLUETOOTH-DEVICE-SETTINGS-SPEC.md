# Bluetooth Device Settings - Implementation Spec

## Overview

Device-specific settings dialog that shows relevant fields based on device type. Each device manufacturer has different requirements (e.g., Victron needs encryption key, RuuviTag doesn't).

## Server-Side Support (✅ COMPLETE)

### 1. WebSocket Message Handler
**Message Type:** `bluetooth:update-metadata`

**Format:**
```javascript
{
  type: 'bluetooth:update-metadata',
  deviceId: 'AA:BB:CC:DD:EE:FF',  // Device MAC address
  metadata: {
    userLabel: 'Salon Temperature',
    notes: 'Mounted near galley',
    encryptionKey: 'd020496a21cf5db1e5ad2c647d1ec72d'  // Optional, Victron only
  },
  timestamp: Date.now()
}
```

**Response:**
```javascript
{
  type: 'bluetooth:response',
  action: 'update-metadata',
  success: true,
  message: 'Device AA:BB:CC:DD:EE:FF metadata updated',
  deviceId: 'AA:BB:CC:DD:EE:FF',
  timestamp: 1234567890
}
```

### 2. Metadata Storage
Metadata is stored in device object:
```javascript
device.metadata = {
  userLabel: 'Custom Name',
  notes: 'User notes',
  encryptionKey: 'hex_key',  // Victron only
  updatedAt: '2025-10-21T12:00:00Z'
}
```

### 3. Automatic Decryption
When encryption key is in metadata, parser automatically decrypts data on next broadcast.

## Client-Side Implementation Guide

### Device Configuration Map

```javascript
// src/config/bluetoothDevices.js
export const DEVICE_CONFIGS = {
  // RuuviTag (Manufacturer ID: 1177 / 0x0499)
  1177: {
    name: 'RuuviTag',
    manufacturer: 'Ruuvi Innovations',
    icon: 'thermometer-outline',
    fields: {
      userLabel: true,
      notes: true,
      encryptionKey: false  // ❌ Not needed
    },
    showLiveData: true,
    liveDataFields: ['temperature', 'humidity', 'pressure', 'battery']
  },
  
  // Victron Energy (Manufacturer ID: 737 / 0x02E1)
  737: {
    name: 'Victron Device',
    manufacturer: 'Victron Energy',
    icon: 'battery-charging-outline',
    fields: {
      userLabel: true,
      notes: true,
      encryptionKey: true  // ✅ Required!
    },
    encryptionKeyRequired: true,
    encryptionKeyValidation: /^[0-9a-fA-F]{32}$/,
    encryptionKeyHelp: 'Open VictronConnect app → Product Info → Copy "Instant readout details" key',
    showLiveData: true,
    liveDataFields: ['voltage', 'current', 'stateOfCharge', 'timeRemaining']
  },
  
  // Default for unknown devices
  default: {
    name: 'Bluetooth Device',
    manufacturer: 'Unknown',
    icon: 'bluetooth-outline',
    fields: {
      userLabel: true,
      notes: true,
      encryptionKey: false
    },
    showLiveData: false
  }
}

export function getDeviceConfig(manufacturerId) {
  return DEVICE_CONFIGS[manufacturerId] || DEVICE_CONFIGS.default
}
```

### Modal Component Structure

```vue
<!-- BluetoothDeviceSettingsModal.vue -->
<script setup>
import { ref, computed, onMounted } from 'vue'
import { getDeviceConfig } from '@/config/bluetoothDevices'
import { useWebSocket } from '@/composables/useWebSocket'

const props = defineProps({
  device: { type: Object, required: true }
})

const emit = defineEmits(['close', 'updated'])

// Get device-specific configuration
const deviceConfig = computed(() => {
  return getDeviceConfig(props.device.manufacturerId)
})

// Form fields
const userLabel = ref(props.device.metadata?.userLabel || '')
const notes = ref(props.device.metadata?.notes || '')
const encryptionKey = ref(props.device.metadata?.encryptionKey || '')

// Validation
const encryptionKeyError = ref('')
const isValid = computed(() => {
  if (deviceConfig.value.encryptionKeyRequired && !encryptionKey.value) {
    return false
  }
  if (encryptionKey.value && deviceConfig.value.encryptionKeyValidation) {
    return deviceConfig.value.encryptionKeyValidation.test(encryptionKey.value)
  }
  return true
})

// Show/hide fields based on device type
const showEncryptionKey = computed(() => {
  return deviceConfig.value.fields.encryptionKey
})

const showLiveData = computed(() => {
  return deviceConfig.value.showLiveData && props.device.sensorData
})

// Status indicator
const encryptionStatus = computed(() => {
  if (!showEncryptionKey.value) return null
  
  const hasKey = props.device.metadata?.encryptionKey
  const hasData = props.device.sensorData && Object.keys(props.device.sensorData).length > 0
  
  if (hasKey && hasData) {
    return { icon: 'checkmark-circle', color: 'success', text: 'Connected & Decrypting' }
  } else if (hasKey && !hasData) {
    return { icon: 'time', color: 'warning', text: 'Waiting for data...' }
  } else {
    return { icon: 'alert-circle', color: 'danger', text: 'Encryption key required' }
  }
})

// Save metadata
const { send } = useWebSocket()
const saving = ref(false)

const saveSettings = async () => {
  // Validate encryption key if required
  if (showEncryptionKey.value && encryptionKey.value) {
    if (!deviceConfig.value.encryptionKeyValidation.test(encryptionKey.value)) {
      encryptionKeyError.value = 'Invalid encryption key format (must be 32 hex characters)'
      return
    }
  }
  
  saving.value = true
  
  try {
    // Build metadata object
    const metadata = {
      userLabel: userLabel.value,
      notes: notes.value
    }
    
    // Add encryption key if provided
    if (showEncryptionKey.value && encryptionKey.value) {
      metadata.encryptionKey = encryptionKey.value
    }
    
    // Send update message
    const message = {
      type: 'bluetooth:update-metadata',
      deviceId: props.device.id,
      metadata: metadata,
      timestamp: Date.now()
    }
    
    await send(message)
    
    emit('updated', metadata)
    emit('close')
  } catch (error) {
    console.error('Failed to update device metadata:', error)
    // Show error toast
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ion-modal>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-button @click="$emit('close')">Cancel</ion-button>
        </ion-buttons>
        <ion-title>{{ deviceConfig.name }} Settings</ion-title>
        <ion-buttons slot="end">
          <ion-button 
            @click="saveSettings" 
            :disabled="!isValid || saving"
            strong
          >
            {{ saving ? 'Saving...' : 'Save' }}
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    
    <ion-content class="ion-padding">
      <!-- Device Info (Read-only) -->
      <ion-card>
        <ion-card-header>
          <ion-card-title>
            <ion-icon :icon="deviceConfig.icon"></ion-icon>
            {{ device.name || 'Unknown Device' }}
          </ion-card-title>
          <ion-card-subtitle>{{ deviceConfig.manufacturer }}</ion-card-subtitle>
        </ion-card-header>
        <ion-card-content>
          <p><strong>MAC Address:</strong> {{ device.id }}</p>
          <p v-if="device.rssi"><strong>Signal:</strong> {{ device.rssi }} dBm</p>
        </ion-card-content>
      </ion-card>
      
      <!-- Encryption Status (Victron only) -->
      <ion-card v-if="showEncryptionKey && encryptionStatus">
        <ion-card-content>
          <ion-item lines="none">
            <ion-icon 
              :icon="encryptionStatus.icon" 
              :color="encryptionStatus.color"
              slot="start"
            ></ion-icon>
            <ion-label>
              <h3>{{ encryptionStatus.text }}</h3>
            </ion-label>
          </ion-item>
        </ion-card-content>
      </ion-card>
      
      <!-- Common Fields -->
      <ion-list>
        <ion-item>
          <ion-label position="stacked">Device Label (Custom Name)</ion-label>
          <ion-input 
            v-model="userLabel" 
            placeholder="e.g., Salon Temperature"
          ></ion-input>
        </ion-item>
        
        <ion-item>
          <ion-label position="stacked">Notes</ion-label>
          <ion-textarea 
            v-model="notes" 
            placeholder="Optional notes about this device..."
            :rows="3"
          ></ion-textarea>
        </ion-item>
      </ion-list>
      
      <!-- Encryption Key (Victron only) -->
      <ion-list v-if="showEncryptionKey">
        <ion-list-header>
          <ion-label>Encryption Settings</ion-label>
        </ion-list-header>
        
        <ion-item>
          <ion-label position="stacked">
            Encryption Key
            <ion-text color="danger" v-if="deviceConfig.encryptionKeyRequired">*</ion-text>
          </ion-label>
          <ion-input 
            v-model="encryptionKey" 
            placeholder="32 character hex key"
            :maxlength="32"
            type="text"
            autocomplete="off"
          ></ion-input>
        </ion-item>
        
        <ion-item lines="none" v-if="encryptionKeyError">
          <ion-label color="danger">
            <p>{{ encryptionKeyError }}</p>
          </ion-label>
        </ion-item>
        
        <ion-item lines="none">
          <ion-label class="ion-text-wrap">
            <ion-text color="medium">
              <p style="font-size: 0.9em;">{{ deviceConfig.encryptionKeyHelp }}</p>
            </ion-text>
          </ion-label>
        </ion-item>
      </ion-list>
      
      <!-- Live Data Preview -->
      <ion-card v-if="showLiveData">
        <ion-card-header>
          <ion-card-title>Current Data</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <!-- RuuviTag Data -->
          <div v-if="device.manufacturerId === 1177">
            <ion-item v-if="device.sensorData.temperature">
              <ion-label>Temperature</ion-label>
              <ion-note slot="end">
                {{ device.sensorData.temperature.value }}{{ device.sensorData.temperature.unit }}
                <span v-if="device.sensorData.temperature.fahrenheit">
                  ({{ device.sensorData.temperature.fahrenheit.toFixed(1) }}°F)
                </span>
              </ion-note>
            </ion-item>
            <ion-item v-if="device.sensorData.humidity">
              <ion-label>Humidity</ion-label>
              <ion-note slot="end">
                {{ device.sensorData.humidity.value }}{{ device.sensorData.humidity.unit }}
              </ion-note>
            </ion-item>
            <ion-item v-if="device.sensorData.pressure">
              <ion-label>Pressure</ion-label>
              <ion-note slot="end">
                {{ device.sensorData.pressure.value }}{{ device.sensorData.pressure.unit }}
              </ion-note>
            </ion-item>
          </div>
          
          <!-- Victron Data -->
          <div v-if="device.manufacturerId === 737">
            <ion-item v-if="device.sensorData.voltage">
              <ion-label>Voltage</ion-label>
              <ion-note slot="end">
                {{ device.sensorData.voltage.value }}{{ device.sensorData.voltage.unit }}
              </ion-note>
            </ion-item>
            <ion-item v-if="device.sensorData.current">
              <ion-label>Current</ion-label>
              <ion-note slot="end">
                {{ device.sensorData.current.value }}{{ device.sensorData.current.unit }}
              </ion-note>
            </ion-item>
            <ion-item v-if="device.sensorData.stateOfCharge">
              <ion-label>State of Charge</ion-label>
              <ion-note slot="end">
                {{ device.sensorData.stateOfCharge.value }}{{ device.sensorData.stateOfCharge.unit }}
              </ion-note>
            </ion-item>
            <ion-item v-if="device.sensorData.timeRemaining">
              <ion-label>Time Remaining</ion-label>
              <ion-note slot="end">
                {{ Math.floor(device.sensorData.timeRemaining.value / 60) }}h 
                {{ device.sensorData.timeRemaining.value % 60 }}m
              </ion-note>
            </ion-item>
          </div>
        </ion-card-content>
      </ion-card>
    </ion-content>
  </ion-modal>
</template>
```

### Usage in Device List

```vue
<!-- In your Bluetooth device list component -->
<template>
  <ion-item v-for="device in devices" :key="device.id">
    <ion-label>{{ device.name }}</ion-label>
    <ion-button slot="end" fill="clear" @click="openSettings(device)">
      <ion-icon :icon="pencilOutline"></ion-icon>
    </ion-button>
  </ion-item>
</template>

<script setup>
import { modalController } from '@ionic/vue'
import BluetoothDeviceSettingsModal from './BluetoothDeviceSettingsModal.vue'

const openSettings = async (device) => {
  const modal = await modalController.create({
    component: BluetoothDeviceSettingsModal,
    componentProps: {
      device: device
    }
  })
  
  modal.present()
  
  const { data } = await modal.onWillDismiss()
  if (data?.updated) {
    // Metadata was updated, refresh device list if needed
  }
}
</script>
```

## Testing

1. **RuuviTag**: Open settings, should NOT see encryption key field
2. **Victron**: Open settings, SHOULD see encryption key field with validation
3. **Save**: Metadata should persist and be visible in Bluetooth state logs
4. **Decryption**: After adding Victron key, battery data should appear within 10 seconds

## Summary

✅ Server handles `bluetooth:update-metadata` messages  
✅ Metadata stored in device object  
✅ Automatic decryption when key is present  
✅ Client shows device-specific fields  
✅ Validation for encryption key format  
✅ Live data preview in settings dialog  
