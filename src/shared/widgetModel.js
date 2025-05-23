// src/shared/widgetModel.js
import { getDataSourceById } from '@/shared/widgetDataConfig.js';

/**
 * Creates a standardized widget object with consistent properties
 * @param {Object} widgetData - The widget data to standardize
 * @returns {Object} - A standardized widget object
 */
export function createWidgetModel(widgetData = {}) {
    console.log('createWidgetModel input:', JSON.stringify(widgetData, null, 2));
    
    // Ensure dataSource is explicitly logged
    console.log('Input dataSource:', widgetData.dataSource);
    
    const standardWidget = {
      // Unique identifier
      id: widgetData.id || `widget-${Date.now()}`,
      
      // Position and size (for layout)
      x: widgetData.x || 0,
      y: widgetData.y || 0,
      width: widgetData.width || 200,
      height: widgetData.height || 200,
      
      // Widget area (if specified)
      area: typeof widgetData.area === 'object' && widgetData.area !== null && 'area' in widgetData.area 
        ? widgetData.area.area 
        : widgetData.area || null,
      
      // Widget type information
      type: widgetData.type || 'instrument',
      displayType: widgetData.displayType || widgetData.type || 'instrument',
      component: widgetData.component || widgetData.type || widgetData.displayType || 'instrument',
      
      // Widget data configuration
      dataSource: widgetData.dataSource || null,
      widgetName: widgetData.widgetName || 'Unnamed Widget',
      widgetTitle: widgetData.widgetTitle || widgetData.widgetName || 'Unnamed Widget',
      
      // Get data source configuration
      dataConfig: getDataSourceById(widgetData.dataSource),
      
      // Display settings
      graphType: widgetData.graphType || 'line',
      graphColor: widgetData.graphColor || '#3880ff',
      maintainAspectRatio: widgetData.maintainAspectRatio !== undefined ? widgetData.maintainAspectRatio : true,
      aspectRatio: widgetData.aspectRatio || 1, // Default to 1:1 (square)
      
      // Number formatting options
      decimalPlaces: widgetData.decimalPlaces !== undefined ? widgetData.decimalPlaces : 1,
      showThousandsSeparator: widgetData.showThousandsSeparator !== undefined ? widgetData.showThousandsSeparator : false,
      
      // Creation timestamp
      createdAt: widgetData.createdAt || Date.now(),
      
      // Store the original data for reference
      data: widgetData
    };

    // Set default units from data source config if available
    if (standardWidget.dataConfig?.defaultUnits) {
      standardWidget.units = standardWidget.dataConfig.defaultUnits;
    }

    // Calculate dimensions based on aspect ratio
    if (standardWidget.maintainAspectRatio) {
      const aspectRatio = standardWidget.aspectRatio;
      const minDimension = Math.min(standardWidget.width, standardWidget.height);
      standardWidget.width = minDimension * aspectRatio;
      standardWidget.height = minDimension;
      
      // Ensure dimensions are at least 100px to maintain visibility
      if (standardWidget.width < 100) {
        standardWidget.width = 100;
        standardWidget.height = 100 / aspectRatio;
      }
      if (standardWidget.height < 100) {
        standardWidget.height = 100;
        standardWidget.width = 100 * aspectRatio;
      }
    }
    
    console.log('createWidgetModel output:', JSON.stringify(standardWidget, null, 2));
    console.log('Output dataSource:', standardWidget.dataSource);
    
    return standardWidget;
  }
  
  /**
   * Validates if a widget has the required properties
   * @param {Object} widget - The widget to validate
   * @returns {boolean} - Whether the widget is valid
   */
  export function isValidWidget(widget) {
    return (
      widget &&
      (widget.id || widget.i) &&
      (widget.type || widget.displayType || widget.component) &&
      (widget.dataSource !== undefined)
    );
  }