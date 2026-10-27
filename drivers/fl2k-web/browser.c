#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include "libusb.h"

static int transport_error;

EM_JS(int, web_device_count, (), {
  return Module.usb.devices.length;
});

EM_ASYNC_JS(int, web_usb_call, (int operation, int index, int argument, int extra), {
  try {
    await Module.usb.call(operation, index, argument, extra);
    return 0;
  } catch (error) {
    Module.usb.error = error.message;
    return -3;
  }
});

EM_ASYNC_JS(int, web_control, (int type, int request, int value, int index, unsigned char *data, int length, int timeout), {
  let timer;
  try {
    const setup = { requestType: 'vendor', recipient: 'device', request, value, index };
    const device = Module.usb.device;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        device.close().catch(() => {});
        reject(new Error('FL2K control transfer timed out; USB closed'));
      }, timeout || 300);
    });
    if (type & 128) {
      const result = await Promise.race([device.controlTransferIn(setup, length), deadline]);
      if (result.status !== 'ok' || !result.data || result.data.byteLength !== length) throw new Error('FL2K short or stalled control read');
      HEAPU8.set(new Uint8Array(result.data.buffer, result.data.byteOffset, length), data);
    } else {
      const result = await Promise.race([device.controlTransferOut(setup, HEAPU8.slice(data, data + length)), deadline]);
      if (result.status !== 'ok' || result.bytesWritten !== length) throw new Error('FL2K short or stalled control write');
    }
    return length;
  } catch (error) {
    Module.usb.error = error.message;
    return -3;
  } finally { clearTimeout(timer); }
});

int libusb_init(libusb_context **context) {
  *context = calloc(1, sizeof(libusb_context));
  return *context ? 0 : -11;
}
void libusb_exit(libusb_context *context) { free(context); }
void libusb_set_debug(libusb_context *context, int level) {}
ssize_t libusb_get_device_list(libusb_context *context, libusb_device ***list) {
  int count = web_device_count();
  *list = calloc(count + 1, sizeof(libusb_device *));
  if (!*list) return -11;
  for (int index = 0; index < count; index++) {
    (*list)[index] = malloc(sizeof(libusb_device));
    if (!(*list)[index]) {
      libusb_free_device_list(*list, 1);
      *list = NULL;
      return -11;
    }
    (*list)[index]->index = index;
  }
  return count;
}
void libusb_free_device_list(libusb_device **list, int unref) {
  if (!list) return;
  for (int index = 0; list[index]; index++) free(list[index]);
  free(list);
}
int libusb_get_device_descriptor(libusb_device *device, struct libusb_device_descriptor *descriptor) {
  descriptor->idVendor = 0x1d5c;
  descriptor->idProduct = 0x2000;
  return 0;
}
int libusb_open(libusb_device *device, libusb_device_handle **handle) {
  int result = web_usb_call(0, device->index, 0, 0);
  if (result < 0) return result;
  *handle = malloc(sizeof(libusb_device_handle));
  if (!*handle) { web_usb_call(1, 0, 0, 0); return -11; }
  (*handle)->index = device->index;
  return 0;
}
void libusb_close(libusb_device_handle *handle) {
  if (handle) { web_usb_call(1, handle->index, 0, 0); free(handle); }
}
int libusb_kernel_driver_active(libusb_device_handle *handle, int interface_number) { return 0; }
int libusb_detach_kernel_driver(libusb_device_handle *handle, int interface_number) { return -3; }
int libusb_claim_interface(libusb_device_handle *handle, int interface_number) {
  return web_usb_call(2, handle->index, interface_number, 0);
}
int libusb_release_interface(libusb_device_handle *handle, int interface_number) {
  return handle ? web_usb_call(3, handle->index, interface_number, 0) : 0;
}
int libusb_set_interface_alt_setting(libusb_device_handle *handle, int interface_number, int alternate) {
  return web_usb_call(4, handle->index, interface_number, alternate);
}
int libusb_control_transfer(libusb_device_handle *handle, uint8_t type, uint8_t request, uint16_t value, uint16_t index, unsigned char *data, uint16_t length, unsigned int timeout) {
  int result = web_control(type, request, value, index, data, length, timeout);
  if (result < 0) transport_error = result;
  return result;
}

#include "../osmo-fl2k/src/libosmo-fl2k.c"

static fl2k_dev_t *browser_device;

EMSCRIPTEN_KEEPALIVE int fl2k_web_open(int index) {
  if (browser_device) return FL2K_ERROR_BUSY;
  transport_error = 0;
  int result = fl2k_open(&browser_device, index);
  if (result < 0 || transport_error < 0) {
    if (browser_device) { fl2k_close(browser_device); browser_device = NULL; }
    return result < 0 ? result : transport_error;
  }
  return 0;
}
EMSCRIPTEN_KEEPALIVE int fl2k_web_close(void) {
  if (!browser_device) return 0;
  int result = fl2k_close(browser_device);
  browser_device = NULL;
  return result;
}
EMSCRIPTEN_KEEPALIVE int fl2k_web_set_rate(uint32_t rate) {
  if (rate < 8000000 || rate > 160000000) return FL2K_ERROR_INVALID_PARAM;
  return fl2k_set_sample_rate(browser_device, rate);
}
EMSCRIPTEN_KEEPALIVE uint32_t fl2k_web_get_rate(void) { return fl2k_get_sample_rate(browser_device); }
EMSCRIPTEN_KEEPALIVE int fl2k_web_read_reg(uint16_t reg, uint32_t *value) { return fl2k_read_reg(browser_device, reg, value); }
EMSCRIPTEN_KEEPALIVE int fl2k_web_write_reg(uint16_t reg, uint32_t value) { return fl2k_write_reg(browser_device, reg, value); }
EMSCRIPTEN_KEEPALIVE int fl2k_web_i2c_read(uint8_t address, uint8_t reg, uint8_t *data) { return fl2k_i2c_read(browser_device, address, reg, data); }
EMSCRIPTEN_KEEPALIVE int fl2k_web_i2c_write(uint8_t address, uint8_t reg, uint8_t *data) { return fl2k_i2c_write(browser_device, address, reg, data); }
EMSCRIPTEN_KEEPALIVE int fl2k_web_pack(char *output, char *red, char *green, char *blue, int signed_samples) {
  if (!output) return FL2K_ERROR_INVALID_PARAM;
  memset(output, 128, FL2K_XFER_LEN);
  fl2k_convert_r(output, red, FL2K_XFER_LEN, signed_samples ? 128 : 0);
  fl2k_convert_g(output, green, FL2K_XFER_LEN, signed_samples ? 128 : 0);
  fl2k_convert_b(output, blue, FL2K_XFER_LEN, signed_samples ? 128 : 0);
  return FL2K_XFER_LEN;
}
